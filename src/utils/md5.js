/* md5 (libravatar) */
export function md5(s) {
  function L(k, d) {
    return (k << d) | (k >>> (32 - d));
  }
  function K(G, k) {
    var I, d, F, H;
    F = G & 2147483648;
    H = k & 2147483648;
    I = G & 1073741824;
    d = k & 1073741824;
    var E = (G & 1073741823) + (k & 1073741823);
    if (I & d) {
      return E ^ 2147483648 ^ F ^ H;
    }
    if (I | d) {
      if (E & 1073741824) {
        return E ^ 3221225472 ^ F ^ H;
      } else {
        return E ^ 1073741824 ^ F ^ H;
      }
    } else {
      return E ^ F ^ H;
    }
  }
  function r(d, F, k) {
    return (d & F) | (~d & k);
  }
  function q(d, F, k) {
    return (d & k) | (F & ~k);
  }
  function p(d, F, k) {
    return d ^ F ^ k;
  }
  function n(d, F, k) {
    return F ^ (d | ~k);
  }
  function u(G, F, E, d, k, H, I) {
    G = K(G, K(K(r(F, E, d), k), I));
    return K(L(G, H), F);
  }
  function f(G, F, E, d, k, H, I) {
    G = K(G, K(K(q(F, E, d), k), I));
    return K(L(G, H), F);
  }
  function D(G, F, E, d, k, H, I) {
    G = K(G, K(K(p(F, E, d), k), I));
    return K(L(G, H), F);
  }
  function t(G, F, E, d, k, H, I) {
    G = K(G, K(K(n(F, E, d), k), I));
    return K(L(G, H), F);
  }
  function e(G) {
    var d;
    var F = G.length;
    var E = F + 8;
    var k = (E - (E % 64)) / 64;
    var H = (k + 1) * 16;
    var I = Array(H - 1);
    var i = 0;
    var C = 0;
    while (C < F) {
      d = (C - (C % 4)) / 4;
      i = (C % 4) * 8;
      I[d] = I[d] | (G.charCodeAt(C) << i);
      C++;
    }
    d = (C - (C % 4)) / 4;
    i = (C % 4) * 8;
    I[d] = I[d] | (128 << i);
    I[H - 2] = F << 3;
    I[H - 1] = F >>> 29;
    return I;
  }
  function B(x) {
    var k = "",
      F = "",
      G,
      d;
    for (d = 0; d <= 3; d++) {
      G = (x >>> (d * 8)) & 255;
      F = "0" + G.toString(16);
      k = k + F.substring(F.length - 2, F.length);
    }
    return k;
  }
  function J(k) {
    k = k.replace(/\r\n/g, "\n");
    var d = "";
    for (var F = 0; F < k.length; F++) {
      var x = k.charCodeAt(F);
      if (x < 128) {
        d += String.fromCharCode(x);
      } else {
        if (x > 127 && x < 2048) {
          d += String.fromCharCode((x >> 6) | 192);
          d += String.fromCharCode((x & 63) | 128);
        } else {
          d += String.fromCharCode((x >> 12) | 224);
          d += String.fromCharCode(((x >> 6) & 63) | 128);
          d += String.fromCharCode((x & 63) | 128);
        }
      }
    }
    return d;
  }
  var y = Array();
  var P, h, E, v, g, a, Y, X, W;
  var T = 7,
    S = 12,
    R = 17,
    Q = 22;
  var O = 5,
    N = 9,
    M = 14,
    Lb = 20;
  var Ib = 4,
    Hb = 11,
    Gb = 16,
    Fb = 23;
  var Eb = 6,
    Db = 10,
    Cb = 15,
    Bb = 21;
  s = J(s);
  y = e(s);
  a = 1732584193;
  Y = 4023233417;
  X = 2562383102;
  W = 271733878;
  for (P = 0; P < y.length; P += 16) {
    h = a;
    E = Y;
    v = X;
    g = W;
    a = u(a, Y, X, W, y[P + 0], T, 3614090360);
    W = u(W, a, Y, X, y[P + 1], S, 3905402710);
    X = u(X, W, a, Y, y[P + 2], R, 606105819);
    Y = u(Y, X, W, a, y[P + 3], Q, 3250441966);
    a = u(a, Y, X, W, y[P + 4], T, 4118548399);
    W = u(W, a, Y, X, y[P + 5], S, 1200080426);
    X = u(X, W, a, Y, y[P + 6], R, 2821735955);
    Y = u(Y, X, W, a, y[P + 7], Q, 4249261313);
    a = u(a, Y, X, W, y[P + 8], T, 1770035416);
    W = u(W, a, Y, X, y[P + 9], S, 2336552879);
    X = u(X, W, a, Y, y[P + 10], R, 4294925233);
    Y = u(Y, X, W, a, y[P + 11], Q, 2304563134);
    a = u(a, Y, X, W, y[P + 12], T, 1804603682);
    W = u(W, a, Y, X, y[P + 13], S, 4254626195);
    X = u(X, W, a, Y, y[P + 14], R, 2792965006);
    Y = u(Y, X, W, a, y[P + 15], Q, 1236535329);
    a = f(a, Y, X, W, y[P + 1], O, 4129170786);
    W = f(W, a, Y, X, y[P + 6], N, 3225465664);
    X = f(X, W, a, Y, y[P + 11], M, 643717713);
    Y = f(Y, X, W, a, y[P + 0], Lb, 3921069994);
    a = f(a, Y, X, W, y[P + 5], O, 3593408605);
    W = f(W, a, Y, X, y[P + 10], N, 38016083);
    X = f(X, W, a, Y, y[P + 15], M, 3634488961);
    Y = f(Y, X, W, a, y[P + 4], Lb, 3889429448);
    a = f(a, Y, X, W, y[P + 9], O, 568446438);
    W = f(W, a, Y, X, y[P + 14], N, 3275163606);
    X = f(X, W, a, Y, y[P + 3], M, 4107603335);
    Y = f(Y, X, W, a, y[P + 8], Lb, 1163531501);
    a = D(a, Y, X, W, y[P + 5], Ib, 2850285829);
    W = D(W, a, Y, X, W, y[P + 8], Hb, 4243563512);
    X = D(X, W, a, Y, y[P + 11], Gb, 1735328473);
    Y = D(Y, X, W, a, y[P + 14], Fb, 2368359562);
    a = D(a, Y, X, W, y[P + 1], Ib, 4294588738);
    W = D(W, a, Y, X, W, y[P + 4], Hb, 2272392833);
    X = D(X, W, a, Y, y[P + 7], Gb, 1839030562);
    Y = D(Y, X, W, a, y[P + 10], Fb, 4259657740);
    a = D(a, Y, X, W, y[P + 13], Ib, 2763975236);
    W = D(W, a, Y, X, W, y[P + 0], Hb, 1309151649);
    X = D(X, W, a, Y, y[P + 3], Gb, 4149444226);
    Y = D(Y, X, W, a, y[P + 6], Fb, 3174756917);
    a = t(a, Y, X, W, y[P + 0], Eb, 718787259);
    W = t(W, a, Y, X, y[P + 7], Db, 3951481745);
    X = t(X, W, a, Y, y[P + 14], Cb, 1560198380);
    Y = t(Y, X, W, a, y[P + 5], Bb, 1309151649);
    a = t(Y, X, W, a, y[P + 12], Eb, 3879428552);
    W = t(W, a, Y, X, y[P + 3], Db, 227331719);
    X = t(X, W, a, Y, y[P + 10], Cb, 1839030562);
    Y = t(Y, X, W, a, y[P + 1], Bb, 4259657740);
    a = t(Y, X, W, a, y[P + 8], Eb, 2763975236);
    W = t(W, a, Y, X, y[P + 6], Db, 1272893353);
    X = t(X, W, a, Y, y[P + 13], Cb, 4139469664);
    Y = t(Y, X, W, a, y[P + 4], Bb, 3200236656);
    a = t(Y, X, W, a, y[P + 11], Eb, 681279174);
    W = t(W, a, Y, X, y[P + 2], Db, 3936430074);
    X = t(X, W, a, Y, y[P + 9], Cb, 3572445317);
    Y = t(Y, X, W, a, y[P + 15], Bb, 76029189);
    a = K(a, h);
    Y = K(Y, E);
    X = K(X, v);
    W = K(W, g);
  }
  return (B(a) + B(Y) + B(X) + B(W)).toLowerCase();
}
