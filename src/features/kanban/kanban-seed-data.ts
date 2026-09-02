/**
 * Static sample mail for the two seeded kanban folders. Ages are hours
 * before "now" so the columns read as a live work queue whenever the
 * feature is first unlocked; everything else is fixed text.
 */

export const NEEDS_REPLY_FOLDER_NAME = 'Needs Reply';
export const BLOCKED_FOLDER_NAME = 'Blocked';

export interface SeedMail {
  from: { name: string; email: string };
  subject: string;
  /** Hours before seeding time. */
  ageHours: number;
  seen: boolean;
  body: string;
}

export const NEEDS_REPLY_MAILS: readonly SeedMail[] = Object.freeze([
  {
    from: { name: 'Priya Natarajan', email: 'priya.natarajan@example.com' },
    subject: 'Q3 roadmap review — can you confirm the Thursday slot?',
    ageHours: 2,
    seen: false,
    body: 'Hi,\n\nI\'m locking the Q3 roadmap review for Thursday at 14:00. Can you confirm you can make it, or send two alternatives? I\'d like the whole platform group in the room.\n\nThanks,\nPriya',
  },
  {
    from: { name: 'Marcus Feldt', email: 'marcus.feldt@example.com' },
    subject: 'Re: Onboarding checklist for the new SRE hire',
    ageHours: 5,
    seen: false,
    body: 'Following up on this. Ines starts on Monday and I still need your sign-off on the access list (prod read-only, staging admin). Could you reply today so IT can provision over the weekend?\n\nMarcus',
  },
  {
    from: { name: 'Elena Kovač', email: 'elena.kovac@example.com' },
    subject: 'Design review feedback on the settings redesign',
    ageHours: 9,
    seen: true,
    body: 'Hi,\n\nI\'ve attached my notes from the review. Two open questions for you:\n\n1. Do we keep the legacy toggle for one more release?\n2. Who owns the copy for the migration banner?\n\nWould love your take before Friday\'s sync.\n\nElena',
  },
  {
    from: { name: 'Tomás Herrera', email: 'tomas.herrera@example.com' },
    subject: 'Vendor contract renewal — decision needed by the 15th',
    ageHours: 14,
    seen: false,
    body: 'The monitoring vendor sent the renewal quote (12% increase). We can negotiate down if we commit to two years. I need a yes/no from you on the two-year option before I go back to them.\n\nTomás',
  },
  {
    from: { name: 'Aisha Rahman', email: 'aisha.rahman@example.com' },
    subject: 'Can you review PR #4821 before the release branch cut?',
    ageHours: 20,
    seen: false,
    body: 'Hey,\n\nPR #4821 (rate limiter rewrite) has been sitting for two days. You\'re the code owner for that path. The release branch cuts tomorrow morning — could you take a look today?\n\nAisha',
  },
  {
    from: { name: 'Daniel Osei', email: 'daniel.osei@example.com' },
    subject: 'Interview loop for the staff engineer candidate',
    ageHours: 27,
    seen: true,
    body: 'Hi,\n\nWe have a strong staff engineer candidate and I\'d like you on the system design panel. Proposed slots: Tue 10:00, Wed 15:30. Which works? Also, any specific areas you want to probe?\n\nDaniel',
  },
  {
    from: { name: 'Sofia Lindqvist', email: 'sofia.lindqvist@example.com' },
    subject: 'Budget line for the conference sponsorship',
    ageHours: 31,
    seen: false,
    body: 'Finance is asking which cost center the conference sponsorship should hit. Is it engineering brand or recruiting? Reply with the code and I\'ll file it.\n\nSofia',
  },
  {
    from: { name: 'Ravi Menon', email: 'ravi.menon@example.com' },
    subject: 'Customer escalation: Northwind data export timing out',
    ageHours: 38,
    seen: false,
    body: 'Northwind\'s weekly export has timed out three runs in a row. They\'re asking for an ETA on a fix and whether we can run it manually in the meantime. Can you reply to them directly (cc me) with what we can commit to?\n\nRavi',
  },
  {
    from: { name: 'Hannah Weiss', email: 'hannah.weiss@example.com' },
    subject: 'Speaker slot at the internal tech talk series',
    ageHours: 45,
    seen: true,
    body: 'Hi,\n\nWe have an open 30-minute slot on the 22nd. Would you give the talk on the sync engine redesign? Let me know by Wednesday so I can publish the schedule.\n\nHannah',
  },
  {
    from: { name: 'Luca Bianchi', email: 'luca.bianchi@example.com' },
    subject: 'Re: Incident 2291 post-mortem action items',
    ageHours: 52,
    seen: false,
    body: 'Two of the action items from the 2291 post-mortem are assigned to you (alerting threshold review, runbook update). Can you confirm owners and target dates so I can close the doc?\n\nLuca',
  },
  {
    from: { name: 'Mei Tanaka', email: 'mei.tanaka@example.com' },
    subject: 'Partner API access request from Contoso',
    ageHours: 60,
    seen: false,
    body: 'Contoso is requesting sandbox API keys for their integration pilot. Legal has approved the NDA. Do you approve issuing keys with the standard rate limits, or do you want a custom tier?\n\nMei',
  },
  {
    from: { name: 'Jonas Berg', email: 'jonas.berg@example.com' },
    subject: 'Quick question on the deprecation timeline for v1 endpoints',
    ageHours: 71,
    seen: true,
    body: 'Docs are asking when we announce the v1 deprecation. I have "end of quarter" in my notes but wanted to confirm with you before it goes in the changelog.\n\nJonas',
  },
  {
    from: { name: 'Fatima Al-Sayed', email: 'fatima.alsayed@example.com' },
    subject: 'Mentorship program — will you take a mentee this cycle?',
    ageHours: 84,
    seen: false,
    body: 'Hi,\n\nSign-ups for the mentorship program close Friday. You were requested by two engineers. Are you able to take one mentee this cycle?\n\nFatima',
  },
  {
    from: { name: 'Oliver Grant', email: 'oliver.grant@example.com' },
    subject: 'Approve travel for the on-site with the Berlin team?',
    ageHours: 96,
    seen: false,
    body: 'Requesting approval for two nights in Berlin for the architecture on-site (flights + hotel, within policy). Need your approval in the travel tool by Monday.\n\nOliver',
  },
  {
    from: { name: 'Camila Duarte', email: 'camila.duarte@example.com' },
    subject: 'Feedback request: draft of the engineering ladder update',
    ageHours: 110,
    seen: true,
    body: 'I\'ve shared the draft ladder update with you. Would appreciate comments on the senior/staff boundary section in particular. Aiming to finalise next week.\n\nCamila',
  },
]);

export const BLOCKED_MAILS: readonly SeedMail[] = Object.freeze([
  {
    from: { name: 'Build Bot', email: 'ci@example.com' },
    subject: 'main is red: integration suite failing on flaky WebSocket test',
    ageHours: 1,
    seen: false,
    body: 'Pipeline #88214 failed.\n\nFailing job: integration (firefox)\nTest: ws-reconnect.spec > resumes after server restart\n\nWaiting on infra to bump the runner timeout before this can pass.',
  },
  {
    from: { name: 'Nadia Petrova', email: 'nadia.petrova@example.com' },
    subject: 'Staging deploy blocked — waiting on security sign-off',
    ageHours: 3,
    seen: false,
    body: 'The staging deploy of the auth changes is paused until security reviews the new token refresh path. Ticket SEC-1042 is in their queue; ETA unknown.\n\nNadia',
  },
  {
    from: { name: 'Marcus Feldt', email: 'marcus.feldt@example.com' },
    subject: 'Blocked: need prod DB read replica credentials',
    ageHours: 6,
    seen: true,
    body: 'Cannot finish the reporting migration without read replica access. Access request #5531 has been pending with the DBA team since Tuesday.\n\nMarcus',
  },
  {
    from: { name: 'Elena Kovač', email: 'elena.kovac@example.com' },
    subject: 'Icons for the new toolbar are with the design agency',
    ageHours: 8,
    seen: false,
    body: 'The toolbar work is blocked on the final icon set. Agency promised delivery "this week" — I\'ll ping again Thursday.\n\nElena',
  },
  {
    from: { name: 'Tomás Herrera', email: 'tomas.herrera@example.com' },
    subject: 'Procurement hold on the new load balancer licenses',
    ageHours: 12,
    seen: false,
    body: 'Procurement has put a hold on the LB licenses pending a budget re-forecast. Scaling work for the EU region is blocked until this clears.\n\nTomás',
  },
  {
    from: { name: 'Aisha Rahman', email: 'aisha.rahman@example.com' },
    subject: 'Waiting on upstream fix for the SQLite WASM regression',
    ageHours: 17,
    seen: true,
    body: 'The VFS corruption is confirmed as an upstream bug (issue #1930). Maintainers say a patch release is coming but no date. Our workaround branch is parked until then.\n\nAisha',
  },
  {
    from: { name: 'Daniel Osei', email: 'daniel.osei@example.com' },
    subject: 'Offer letter blocked on comp band approval',
    ageHours: 22,
    seen: false,
    body: 'The staff engineer offer is waiting on comp committee approval of the band exception. Next committee meeting is Wednesday.\n\nDaniel',
  },
  {
    from: { name: 'Sofia Lindqvist', email: 'sofia.lindqvist@example.com' },
    subject: 'Expense reimbursements paused — payroll system migration',
    ageHours: 26,
    seen: false,
    body: 'Heads up: reimbursements are paused until the payroll system migration completes on the 20th. Nothing we can do on our side.\n\nSofia',
  },
  {
    from: { name: 'Ravi Menon', email: 'ravi.menon@example.com' },
    subject: 'Northwind fix blocked: customer has not approved the maintenance window',
    ageHours: 30,
    seen: true,
    body: 'We have the patch ready but Northwind hasn\'t approved a maintenance window. Their IT lead is out until next week.\n\nRavi',
  },
  {
    from: { name: 'Hannah Weiss', email: 'hannah.weiss@example.com' },
    subject: 'Room booking for the all-hands is pending facilities',
    ageHours: 35,
    seen: false,
    body: 'Facilities hasn\'t confirmed the auditorium for the all-hands. Until they do I can\'t send the invite.\n\nHannah',
  },
  {
    from: { name: 'Luca Bianchi', email: 'luca.bianchi@example.com' },
    subject: 'Alerting threshold change blocked by observability freeze',
    ageHours: 41,
    seen: false,
    body: 'The observability team has a config freeze until after their vendor migration. Our threshold changes from the 2291 post-mortem are queued behind it.\n\nLuca',
  },
  {
    from: { name: 'Mei Tanaka', email: 'mei.tanaka@example.com' },
    subject: 'Contoso pilot waiting on their legal to countersign',
    ageHours: 47,
    seen: true,
    body: 'Our side is done. Contoso legal has had the agreement for nine days. Their contact says "soon".\n\nMei',
  },
  {
    from: { name: 'Jonas Berg', email: 'jonas.berg@example.com' },
    subject: 'Docs site build blocked by expired CDN certificate',
    ageHours: 53,
    seen: false,
    body: 'The docs preview build fails because the CDN cert expired. IT owns renewal (ticket IT-7710). No changelog publishing until then.\n\nJonas',
  },
  {
    from: { name: 'Fatima Al-Sayed', email: 'fatima.alsayed@example.com' },
    subject: 'Mentorship pairings on hold pending HR tool rollout',
    ageHours: 58,
    seen: false,
    body: 'HR wants pairings recorded in the new tool, which isn\'t live yet. Pairings are frozen until it launches.\n\nFatima',
  },
  {
    from: { name: 'Oliver Grant', email: 'oliver.grant@example.com' },
    subject: 'Berlin on-site agenda blocked on venue confirmation',
    ageHours: 64,
    seen: true,
    body: 'Can\'t finalise the agenda until the venue confirms the second room. They\'ve promised an answer by Friday.\n\nOliver',
  },
  {
    from: { name: 'Camila Duarte', email: 'camila.duarte@example.com' },
    subject: 'Ladder update waiting on leadership review',
    ageHours: 70,
    seen: false,
    body: 'The ladder draft is with the leadership team for review. No changes until they come back with feedback.\n\nCamila',
  },
  {
    from: { name: 'Build Bot', email: 'ci@example.com' },
    subject: 'Nightly perf run skipped: benchmark host offline',
    ageHours: 76,
    seen: false,
    body: 'The nightly perf job was skipped because bench-host-02 is offline. Infra ticket INF-3390 is open.',
  },
  {
    from: { name: 'Priya Natarajan', email: 'priya.natarajan@example.com' },
    subject: 'Roadmap slide deck blocked on finance numbers',
    ageHours: 82,
    seen: true,
    body: 'The Q3 roadmap deck needs the updated cost model from finance. They\'re closing the books this week, so nothing until Monday.\n\nPriya',
  },
  {
    from: { name: 'Nadia Petrova', email: 'nadia.petrova@example.com' },
    subject: 'SSO integration blocked: IdP metadata not yet published',
    ageHours: 90,
    seen: false,
    body: 'The customer\'s identity team hasn\'t published the SAML metadata. We can\'t test the SSO flow until they do.\n\nNadia',
  },
  {
    from: { name: 'Ravi Menon', email: 'ravi.menon@example.com' },
    subject: 'Support macro update pending translation',
    ageHours: 98,
    seen: false,
    body: 'The new support macros are done in English but blocked on translations for DE/FR/ES. Localisation team ETA: two weeks.\n\nRavi',
  },
  {
    from: { name: 'Aisha Rahman', email: 'aisha.rahman@example.com' },
    subject: 'Dependency upgrade held back by breaking change in test runner',
    ageHours: 106,
    seen: true,
    body: 'Upgrading the test runner breaks our custom reporter. Upstream has a fix in review; holding the dependency bump until it ships.\n\nAisha',
  },
  {
    from: { name: 'Tomás Herrera', email: 'tomas.herrera@example.com' },
    subject: 'Data residency review blocking the APAC region launch',
    ageHours: 118,
    seen: false,
    body: 'Legal\'s data residency review for APAC is still in progress. The region launch cannot proceed until it is signed off.\n\nTomás',
  },
  {
    from: { name: 'Elena Kovač', email: 'elena.kovac@example.com' },
    subject: 'Accessibility audit results delayed by the auditor',
    ageHours: 130,
    seen: false,
    body: 'The external accessibility audit report is late. Remediation planning is blocked until we have the findings.\n\nElena',
  },
]);
