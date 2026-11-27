'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parsePrismaSchema,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildDictionaryCsv,
  buildErdMarkdown,
} = require('../src/prismaview');
const { PrismaViewModel } = require('../src/view');
const { editorHtml, csp } = require('../src/html');

const samplePath = path.join(__dirname, '..', 'samples', 'schema.prisma');
const cleanPath = path.join(__dirname, '..', 'samples', 'clean-schema.prisma');
const sampleText = fs.readFileSync(samplePath, 'utf8');
const cleanText = fs.readFileSync(cleanPath, 'utf8');

test('parsePrismaSchema parses datasource, generator, models, enums, relations and indexes', () => {
  const p = parsePrismaSchema(sampleText, 'schema.prisma');
  assert.equal(p.provider, 'postgresql');
  assert.equal(p.stats.datasourceCount, 1);
  assert.equal(p.stats.generatorCount, 1);
  assert.equal(p.stats.modelCount, 5);
  assert.equal(p.stats.enumCount, 2);
  assert.ok(p.relations.length >= 4);
  assert.ok(p.indexes.length >= 6);
});

test('static findings catch plaintext URL, missing @id, unindexed FK, cascade delete and deprecated previewFeatures', () => {
  const p = parsePrismaSchema(sampleText, 'schema.prisma');
  const rules = new Set(p.findings.map((f) => f.rule));
  assert.ok(rules.has('datasource-plaintext-url'), 'should flag plaintext datasource url');
  assert.ok(rules.has('model-missing-id'), 'should flag AuditLog missing @id');
  assert.ok(rules.has('fk-missing-index'), 'should flag unindexed foreign keys');
  assert.ok(rules.has('cascade-delete-hazard'), 'should flag onDelete: Cascade');
  assert.ok(rules.has('deprecated-preview-feature'), 'should flag interactiveTransactions');
});

test('clean schema produces zero static findings', () => {
  const p = parsePrismaSchema(cleanText, 'clean-schema.prisma');
  assert.equal(p.findings.length, 0);
  assert.equal(p.stats.findingErrors, 0);
  assert.equal(p.stats.findingWarnings, 0);
});

test('PrismaViewModel filters by kind, findings and search text', () => {
  const p = parsePrismaSchema(sampleText, 'schema.prisma');
  const vm = new PrismaViewModel(p, 'schema.prisma', sampleText.length);
  assert.equal(vm.totalCount(), p.rows.length);
  assert.equal(vm.setFilter({ kind: 'enum' }), 2);
  assert.equal(vm.setFilter({ kind: 'config' }), 2);
  assert.equal(vm.setFilter({ kind: 'findings' }), 5);
  assert.ok(vm.setFilter({ text: 'invoice' }) >= 1);
  const d = vm.detail(1);
  assert.ok(d && d.name && Array.isArray(d.attrs));
});

test('buildAuditMarkdown, buildDiffMarkdown, buildErdMarkdown and buildDictionaryCsv produce valid output', () => {
  const left = parsePrismaSchema(sampleText, 'schema.prisma');
  const right = parsePrismaSchema(cleanText, 'clean-schema.prisma');
  const audit = buildAuditMarkdown([{ fileName: 'schema.prisma', parsed: left }]);
  assert.ok(audit.includes('# Prisma Schema Performance & Relation-Safety Audit'));
  assert.ok(audit.includes('datasource-plaintext-url'));

  const diff = buildDiffMarkdown('schema.prisma', left, 'clean-schema.prisma', right);
  assert.ok(diff.includes('Breaking Changes'));
  assert.ok(diff.includes('Removed model `Project`'));
  assert.ok(diff.includes('Removed enum value `Role.VIEWER`'));

  const erd = buildErdMarkdown(left, 'schema.prisma');
  assert.ok(erd.includes('```mermaid'));
  assert.ok(erd.includes('erDiagram'));
  assert.ok(erd.includes('Organization ||--o{ User'));

  const csv = buildDictionaryCsv(left);
  assert.ok(csv.startsWith('Model,Field,Type,Nullable,List,Key,Default,RelationTarget,OnDelete,Line\n'));
  assert.ok(csv.includes('Organization,id,String,no,no,PK'));
});

test('editorHtml enforces strict CSP with nonce', () => {
  const c = csp('vscode-webview:', 'abc123');
  assert.ok(c.includes("default-src 'none'"));
  assert.ok(c.includes("script-src 'nonce-abc123'"));
  const html = editorHtml({ cspSource: 'vscode-webview:', script: 'v.js', styleUri: 'v.css', title: 'schema.prisma', nonce: 'abc123' });
  assert.ok(html.includes('nonce="abc123"'));
  assert.ok(html.includes('zovoPrismaview.getPro'));
});
