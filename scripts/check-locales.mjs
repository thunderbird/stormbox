import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import { baseCompile } from '@intlify/message-compiler';

export function flattenMessages(value, prefix = '', result = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid catalog object: ${prefix}`);
  for (const [key, message] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof message === 'string') result[fullKey] = message;
    else flattenMessages(message, fullKey, result);
  }
  return result;
}

const parameterNames = (value) => new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));

export function validateSourceText(code, messages, filename = 'source') {
  const tree = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
  function visit(node) {
    const called = ts.isCallExpression(node) || ts.isNewExpression(node);
    if (called && ['t', 'sourceText', 'LocalizedError'].includes(node.expression.getText(tree))) {
      const [key, params, count] = node.arguments ?? [];
      if (key && ts.isStringLiteral(key)) {
        if (!(key.text in messages)) throw new Error(`${filename}: unknown message ${key.text}`);
        const required = parameterNames(messages[key.text]);
        if ((!params || ts.isObjectLiteralExpression(params)) && !params?.properties.some((item) => ts.isSpreadAssignment(item))) {
          const supplied = new Set(params?.properties.map((item) => item.name?.getText(tree).replace(/^['"]|['"]$/g, '')) ?? []);
          if (count) { supplied.add('count'); supplied.add('n'); }
          for (const name of required) {
            if (!supplied.has(name)) throw new Error(`${filename}: missing parameter ${name} for ${key.text}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

export function validateReferences(directory = path.resolve('src'), catalog = path.join(directory, 'locales/en.json')) {
  const messages = flattenMessages(JSON.parse(fs.readFileSync(catalog, 'utf8')));
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (/\.(?:vue|ts|js)$/.test(entry.name)) {
        const source = fs.readFileSync(filename, 'utf8');
        if (!entry.name.endsWith('.vue')) validateSourceText(source, messages, filename);
        else {
          const { descriptor } = parse(source);
          validateSourceText(descriptor.scriptSetup?.content ?? descriptor.script?.content ?? '', messages, filename);
          const template = descriptor.template?.content ?? '';
          for (const match of template.matchAll(/\{\{([\s\S]*?)\}\}|(?:[:@][\w.-]+|v-[\w.-]+)="([^"]*)"/g)) {
            validateSourceText((match[1] ?? match[2]).replaceAll('&quot;', '"'), messages, filename);
          }
          for (const match of template.matchAll(/(?<!:)keypath="([^"]+)"/g)) {
            if (!(match[1] in messages)) throw new Error(`${filename}: unknown message ${match[1]}`);
          }
        }
      }
    }
  }
  walk(directory);
}

export function validateCatalogs(directory = path.resolve('src/locales')) {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  const source = flattenMessages(JSON.parse(fs.readFileSync(path.join(directory, 'en.json'), 'utf8')));
  let count = 0;
  for (const file of files) {
    const locale = file.slice(0, -5);
    if (Intl.getCanonicalLocales(locale)[0] !== locale) throw new Error(`Use a canonical BCP 47 filename: ${file}`);
    const messages = flattenMessages(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
    for (const [key, message] of Object.entries(messages)) {
      if (!(key in source)) throw new Error(`${file}: unknown key ${key}`);
      if (!message.trim()) throw new Error(`${file}: empty message ${key}`);
      if (/<\/?[a-z][^>]*>/i.test(message)) throw new Error(`${file}: use named slots, not HTML, in ${key}`);
      baseCompile(message, { onError(error) { throw new Error(`${file}:${key}: ${error.message}`); } });
      const placeholders = (value) => new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
      const expected = placeholders(source[key]);
      const actual = placeholders(message);
      if ([...actual].some((name) => !expected.has(name)) || [...expected].some((name) => !actual.has(name))) {
        throw new Error(`${file}:${key}: named parameters must match English (${[...expected].join(', ')})`);
      }
      count += 1;
    }
  }
  return { locales: files.length, messages: count };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateCatalogs();
  validateReferences();
  console.log(`Validated ${result.messages} messages in ${result.locales} catalogs.`);
}
