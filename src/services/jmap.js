const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMIT = "urn:ietf:params:jmap:submission";

const te = new TextEncoder();
const b64 = (s) => btoa(String.fromCharCode(...te.encode(s)));

export class JMAPClient {
  constructor({ baseUrl, username, password, getToken }) {
    this.base = (baseUrl || "").replace(/\/$/, "");
    this.sessionUrl = this.base + "/.well-known/jmap";
    this._getToken = getToken || null;

    if (!getToken && username && password) {
      this._staticAuth = "Basic " + b64(`${username}:${password}`);
    } else {
      this._staticAuth = null;
    }

    this.apiUrl = null;
    this.accountId = null;
    this.downloadUrlTpl = null;

    this.ids = {
      outbox: null,
      sent: null,
      drafts: null,
      trash: null,
      inbox: null,
    };

    // Track active fetch controllers for cancellation on mailbox switch
    this._controllers = new Set();
  }

  async _getAuth() {
    if (this._getToken) {
      const token = await this._getToken();
      return `Bearer ${token}`;
    }
    return this._staticAuth;
  }

  /* ---------- low-level ---------- */
  async fetchSession() {
    const auth = await this._getAuth();
    const headers = { Accept: "application/json" };
    if (auth) headers.Authorization = auth;

    let r = await fetch(this.sessionUrl, {
      headers,
      mode: "cors",
      credentials: "omit",
    });
    if (!r.ok)
      throw new Error(`Session fetch failed: ${r.status} ${r.statusText}`);
    const s = await r.json();
    this.apiUrl = s.apiUrl;
    this.downloadUrlTpl = s.downloadUrl || null;
    this.accountId =
      (s.primaryAccounts && s.primaryAccounts[MAIL]) ||
      Object.keys(s.accounts || {})[0];
    if (!this.apiUrl || !this.accountId)
      throw new Error("Missing apiUrl/accountId");
    return s;
  }

  async jmap(body) {
    const auth = await this._getAuth();
    const ctrl = new AbortController();
    this._controllers.add(ctrl);
    const r = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      mode: "cors",
      credentials: "omit",
      signal: ctrl.signal,
    });
    this._controllers.delete(ctrl);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`JMAP error ${r.status} ${r.statusText}\n${txt}`);
    }
    return r.json();
  }

  async jmapRaw(body) {
    const auth = await this._getAuth();
    const req = JSON.stringify(body);
    const started = new Date().toISOString();
    const ctrl = new AbortController();
    this._controllers.add(ctrl);
    const r = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: req,
      mode: "cors",
      credentials: "omit",
      signal: ctrl.signal,
    });
    this._controllers.delete(ctrl);
    const text = await r.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      started,
      status: r.status,
      statusText: r.statusText,
      ok: r.ok,
      text,
      json,
      req,
    };
  }

  cancelAll() {
    for (const c of Array.from(this._controllers)) {
      try {
        c.abort();
      } catch {}
      this._controllers.delete(c);
    }
  }

  async _jmapCall(methodName, params, callId = "c1") {
    const response = await this.jmap({
      using: [CORE, MAIL],
      methodCalls: [
        [methodName, { accountId: this.accountId, ...params }, callId],
      ],
    });
    return (
      response.methodResponses?.find((x) => x[0] === methodName)?.[1] || null
    );
  }

  _extractResponse(response, methodName) {
    return (
      response.methodResponses?.find((x) => x[0] === methodName)?.[1] || null
    );
  }
  /* ---------- mailboxes & identities ---------- */
  async listMailboxes() {
    const q = {
      accountId: this.accountId,
      sort: [
        { property: "sortOrder", isAscending: true },
        { property: "name", isAscending: true },
      ],
      limit: 500,
    };
    const Rq = await this.jmap({
      using: [CORE, MAIL],
      methodCalls: [["Mailbox/query", q, "m1"]],
    });
    const ids =
      (Rq.methodResponses.find((x) => x[0] === "Mailbox/query") || [])[1]
        ?.ids || [];
    const props = [
      "id",
      "name",
      "role",
      "sortOrder",
      "totalEmails",
      "unreadEmails",
      "parentId",
    ];
    const Rg = ids.length
      ? await this.jmap({
          using: [CORE, MAIL],
          methodCalls: [
            [
              "Mailbox/get",
              { accountId: this.accountId, ids, properties: props },
              "m2",
            ],
          ],
        })
      : null;
    const list = Rg
      ? (Rg.methodResponses.find((x) => x[0] === "Mailbox/get") || [])[1]
          ?.list || []
      : [];

    // Map special folders
    const byRole = (role) =>
      list.find((m) => (m.role || "").toLowerCase() === role);
    const byName = (...names) =>
      list.find((m) => names.includes((m.name || "").toLowerCase()));

    this.ids.outbox = (byRole("outbox") || {}).id || null;
    this.ids.sent =
      (byRole("sent") || byName("sent", "sent items") || {}).id || null;
    this.ids.drafts = (byRole("drafts") || {}).id || null;
    this.ids.trash =
      (byRole("trash") || byName("deleted items", "trash") || {}).id || null;
    this.ids.inbox = (byRole("inbox") || list[0] || {}).id || null;

    return list;
  }

  async listIdentities() {
    const R = await this.jmap({
      using: [CORE, MAIL, SUBMIT],
      methodCalls: [["Identity/get", { accountId: this.accountId }, "i1"]],
    });
    return (
      (R.methodResponses.find((x) => x[0] === "Identity/get") || [])[1]?.list ||
      []
    );
  }

  /* ---------- queries & changes ---------- */
  sortPropForBox(box) {
    const name = (box?.name || "").toLowerCase();
    const role = (box?.role || "").toLowerCase();
    return role === "sent" || name.startsWith("sent") ? "sentAt" : "receivedAt";
  }

  async emailQuery({
    mailboxId,
    position = 0,
    limit = 50,
    sortProp = "receivedAt",
  }) {
    const query = {
      accountId: this.accountId,
      filter: { inMailbox: mailboxId },
      sort: [{ property: sortProp, isAscending: false }],
      position,
      limit,
      calculateTotal: true,
    };
    const Rq = await this.jmap({
      using: [CORE, MAIL],
      methodCalls: [["Email/query", query, "q1"]],
    });
    return (
      Rq.methodResponses.find((x) => x[0] === "Email/query")?.[1] ?? {
        ids: [],
        total: 0,
        queryState: null,
        position: 0,
      }
    );
  }

  async emailGet(ids, properties) {
    if (!ids?.length) return [];
    const Rg = await this.jmap({
      using: [CORE, MAIL],
      methodCalls: [
        ["Email/get", { accountId: this.accountId, ids, properties }, "g1"],
      ],
    });
    return (
      Rg.methodResponses?.find((x) => x[0] === "Email/get")?.[1]?.list || []
    );
  }

  async emailQueryChanges({
    mailboxId,
    sinceQueryState,
    sortProp = "receivedAt",
  }) {
    const body = {
      using: [CORE, MAIL],
      methodCalls: [
        [
          "Email/queryChanges",
          {
            accountId: this.accountId,
            filter: { inMailbox: mailboxId },
            sort: [{ property: sortProp, isAscending: false }],
            sinceQueryState,
            maxChanges: 500,
          },
          "qc1",
        ],
      ],
    };
    const Jr = await this.jmap(body);
    return (
      Jr.methodResponses?.find((x) => x[0] === "Email/queryChanges")?.[1] || {}
    );
  }

  async setSeen(emailId, seen = true) {
    return this.jmap({
      using: [CORE, MAIL],
      methodCalls: [
        [
          "Email/set",
          {
            accountId: this.accountId,
            update: { [emailId]: { "keywords/$seen": !!seen } },
          },
          "u1",
        ],
      ],
    });
  }

  async moveToTrashOrDestroy(emailId, currentMailboxId) {
    const params = this.ids.trash
      ? {
          update: {
            [emailId]: {
              [`mailboxIds/${this.ids.trash}`]: true,
              [`mailboxIds/${currentMailboxId}`]: null,
            },
          },
        }
      : { destroy: [emailId] };

    return this.jmap({
      using: [CORE, MAIL],
      methodCalls: [
        ["Email/set", { ...params, accountId: this.accountId }, "d1"],
      ],
    });
  }

  /* ---------- downloads ---------- */
  makeDownloadUrl(blobId, name) {
    const nm = encodeURIComponent(name || "attachment");
    return (
      this.downloadUrlTpl || `${this.base}/download/{accountId}/{blobId}/{name}`
    )
      .replace("{accountId}", encodeURIComponent(this.accountId))
      .replace("{blobId}", encodeURIComponent(blobId))
      .replace("{name}", nm);
  }

  async downloadAttachment(blobId, name, type) {
    const auth = await this._getAuth();
    const url = this.makeDownloadUrl(blobId, name);
    const r = await fetch(url, {
      headers: { Authorization: auth, Accept: type || "*/*" },
      mode: "cors",
      credentials: "omit",
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const blob = await r.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = name || "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  }

  async downloadPartText(part) {
    const auth = await this._getAuth();
    const url = this.makeDownloadUrl(part.blobId, part.name || "body.txt");
    const r = await fetch(url, {
      headers: { Authorization: auth },
      mode: "cors",
      credentials: "omit",
    });
    if (!r.ok)
      throw new Error(`Blob download failed: ${r.status} ${r.statusText}`);
    const buf = await r.arrayBuffer();
    let dec;
    try {
      dec = new TextDecoder((part.charset || "utf-8").toLowerCase());
    } catch {
      dec = new TextDecoder("utf-8");
    }
    return dec.decode(buf);
  }

  /* ---------- detail (full HTML/text with truncation fallback) ---------- */
  async emailDetail(emailId) {
    const R = await this.jmap({
      using: [CORE, MAIL],
      methodCalls: [
        [
          "Email/get",
          {
            accountId: this.accountId,
            ids: [emailId],
            properties: [
              "id",
              "bodyStructure",
              "textBody",
              "htmlBody",
              "headers",
            ],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            maxBodyValueBytes: 10_485_760, // 10 MB; still fall back to blob download if truncated
            bodyProperties: [
              "partId",
              "type",
              "size",
              "name",
              "blobId",
              "disposition",
              "cid",
              "charset",
              "subParts",
            ],
          },
          "gd",
        ],
      ],
    });
    const em =
      (R.methodResponses.find((x) => x[0] === "Email/get") || [])[1]
        ?.list?.[0] || {};
    const bv = em.bodyValues || {};

    const attachments = [],
      htmlParts = [],
      textParts = [],
      cidMap = {};
    const walk = (p) => {
      if (!p) return;
      const type = (p.type || "").toLowerCase();

      // Collect attachments
      if (
        p.disposition?.toLowerCase() === "attachment" ||
        (p.name && p.blobId)
      ) {
        attachments.push({
          blobId: p.blobId,
          name: p.name || "attachment",
          type: p.type || "application/octet-stream",
          size: p.size,
        });
      }

      // Collect parts by type
      if (type === "text/html") htmlParts.push(p);
      if (type === "text/plain") textParts.push(p);
      if (p.cid && p.blobId) cidMap[p.cid.replace(/^<|>$/g, "")] = p.blobId;

      // Recurse into subparts
      (p.subParts || []).forEach(walk);
    };
    walk(em.bodyStructure);

    const pickLargest = (arr) =>
      [...arr].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    const hp = pickLargest(htmlParts);
    const tp = pickLargest(textParts);

    let html = (hp && bv[hp.partId]?.value) || "";
    let text = (tp && bv[tp.partId]?.value) || "";

    const isTrunc = (p) =>
      p &&
      bv[p.partId] &&
      (bv[p.partId].isTruncated || bv[p.partId].valueIsTruncated);

    // If missing or truncated, fetch full content via blobId
    try {
      if (hp && (!html || isTrunc(hp))) html = await this.downloadPartText(hp);
    } catch {}
    try {
      if (tp && (!text || isTrunc(tp))) text = await this.downloadPartText(tp);
    } catch {}

    return { html, text, attachments, cidMap };
  }

  /* ---------- compose (multipart/alternative, Outbox-first) ---------- */
  async sendMultipartAlternative({
    from,
    identityId,
    toList,
    subject,
    text,
    html,
    draftsId,
    sentId,
  }) {
    const createId = "m1",
      submitId = "s1";
    const hasHtml = html && !/^\s*<p>\s*(<br\s*\/?>)?\s*<\/p>\s*$/i.test(html);
    const targetBox = this.ids.outbox || draftsId || this.ids.drafts || null;

    // Build body structure and values based on content type
    const [bodyStructure, bodyValues] = hasHtml
      ? [
          {
            type: "multipart/alternative",
            subParts: [
              { type: "text/plain", partId: "p1" },
              { type: "text/html", partId: "h1" },
            ],
          },
          { p1: { value: text || "" }, h1: { value: html } },
        ]
      : [{ type: "text/plain", partId: "p1" }, { p1: { value: text || "" } }];

    // Build email create object
    const emailCreate = {
      ...(targetBox && { mailboxIds: { [targetBox]: true } }),
      ...(targetBox === this.ids.drafts && { keywords: { $draft: true } }),
      from: [{ ...(from.name && { name: from.name }), email: from.email }],
      to: toList,
      subject,
      bodyStructure,
      bodyValues,
    };

    // Build submission update object
    const onSuccessUpdate = {
      ...(sentId && { [`mailboxIds/${sentId}`]: true }),
      ...(targetBox && { [`mailboxIds/${targetBox}`]: null }),
      "keywords/$draft": null,
    };

    return this.jmapRaw({
      using: [CORE, MAIL, SUBMIT],
      methodCalls: [
        [
          "Email/set",
          { accountId: this.accountId, create: { [createId]: emailCreate } },
          "c1",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: this.accountId,
            create: {
              [submitId]: {
                identityId,
                emailId: `#${createId}`,
                envelope: {
                  mailFrom: { email: from.email },
                  rcptTo: toList.map((x) => ({ email: x.email })),
                },
              },
            },
            onSuccessUpdateEmail: { [`#${submitId}`]: onSuccessUpdate },
          },
          "c2",
        ],
      ],
    });
  }
}

export const JMAP = { Client: JMAPClient, NS: { CORE, MAIL, SUBMIT } };
