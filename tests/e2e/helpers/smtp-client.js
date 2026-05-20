import tls from 'node:tls';

import {
  SMTP_HOST,
  SMTP_TLS_PORT,
  TEST_SMTP_PASSWORD,
  TEST_THUNDERMAIL,
} from './stack-env.js';

function dotStuff(text) {
  return String(text).replaceAll(/\r?\n\./g, '\r\n..');
}

export async function sendSmtpMessage({
  from = TEST_THUNDERMAIL,
  to = TEST_THUNDERMAIL,
  subject,
  text = 'e2e message',
}) {
  const socket = tls.connect({
    host: SMTP_HOST,
    port: SMTP_TLS_PORT,
    rejectUnauthorized: false,
  });
  socket.setEncoding('utf8');

  let buffer = '';
  const waitFor = (pattern) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SMTP timeout waiting for ${pattern}; saw ${buffer}`));
    }, 10_000);
    const onData = (chunk) => {
      buffer += chunk;
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        socket.off('data', onData);
        const out = buffer;
        buffer = '';
        resolve(out);
      }
    };
    socket.on('data', onData);
  });
  const write = (line) => socket.write(line);

  try {
    await waitFor(/^220/m);
    write('EHLO stormbox-e2e.local\r\n');
    await waitFor(/\n250[ -]/m);

    const auth = Buffer.from(`\0${TEST_THUNDERMAIL}\0${TEST_SMTP_PASSWORD}`).toString('base64');
    write(`AUTH PLAIN ${auth}\r\n`);
    await waitFor(/^235/m);

    write(`MAIL FROM:<${from}>\r\n`);
    await waitFor(/^250/m);
    write(`RCPT TO:<${to}>\r\n`);
    await waitFor(/^250/m);
    write('DATA\r\n');
    await waitFor(/^354/m);
    write([
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(16).slice(2)}@stormbox-e2e.local>`,
      '',
      dotStuff(text),
      '.',
      '',
    ].join('\r\n'));
    await waitFor(/^250/m);
    write('QUIT\r\n');
  } finally {
    socket.end();
  }
}
