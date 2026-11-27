'use strict';
// Pro tools for Prisma Schema & ERD Inspector:
//   1. auditSchema: Offline Markdown Prisma performance & relation-safety audit.
//   2. diffSchemas: Compare two .prisma files in Markdown for breaking schema changes.
//   3. exportErdDoc: Non-destructive Mermaid ERD Markdown and CSV model dictionary export.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  parsePrismaSchema,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildDictionaryCsv,
  buildErdMarkdown,
} = require('./prismaview');

const MATCH_RE = /^(schema\.prisma|.*\.prisma)$/i;

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 1; i < 10000; i += 1) {
    const cand = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function resolveTargetUri(uri, provider, openLabel = 'Select Prisma schema file') {
  if (uri && uri.scheme) return uri;
  if (provider && provider.active && provider.active.uri) return provider.active.uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document && MATCH_RE.test(path.basename(ed.document.uri.fsPath || ed.document.uri.path))) {
    return ed.document.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Prisma Schema': ['prisma'] },
    openLabel,
  });
  return picked && picked[0] ? picked[0] : null;
}

function listPrismaFilesInDir(dirPath, maxDepth = 4) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && MATCH_RE.test(e.name)) out.push(full);
      else if (e.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  }
  walk(dirPath, 0);
  return out.sort();
}

function createTools({ provider, pro, reach }) {
  async function auditSchema(uri, opts = {}) {
    if (!(await pro.allowed('auditSchema', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const isDir = target.scheme === 'file' && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    const files = isDir ? listPrismaFilesInDir(targetPath) : [targetPath];
    if (!files.length) {
      vscode.window.showInformationMessage('No matching .prisma files were found in this folder.');
      return undefined;
    }

    const entries = [];
    for (const f of files) {
      const buf = f === targetPath && target.scheme !== 'file'
        ? Buffer.from(await vscode.workspace.fs.readFile(target))
        : fs.readFileSync(f);
      const label = isDir ? path.relative(targetPath, f) : path.basename(f);
      entries.push({ fileName: label, parsed: parsePrismaSchema(buf, label) });
    }
    const md = buildAuditMarkdown(entries);
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('auditSchema');
    if (reach) reach.refresh();
    return { files: files.length, markdown: md };
  }

  async function diffSchemas(uri, opts = {}) {
    if (!(await pro.allowed('diffSchemas', opts))) return undefined;
    const left = await resolveTargetUri(uri, provider, 'Select baseline Prisma schema file');
    if (!left) return undefined;

    let right = opts.compareUri || null;
    if (!right) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Prisma Schema': ['prisma'] },
        openLabel: 'Select second Prisma schema file to compare',
      });
      right = picked && picked[0] ? picked[0] : null;
    }
    if (!right) return undefined;

    const leftBuf = Buffer.from(await vscode.workspace.fs.readFile(left));
    const rightBuf = Buffer.from(await vscode.workspace.fs.readFile(right));
    const leftName = path.basename(left.fsPath || left.path);
    const rightName = path.basename(right.fsPath || right.path);
    const md = buildDiffMarkdown(
      leftName,
      parsePrismaSchema(leftBuf, leftName),
      rightName,
      parsePrismaSchema(rightBuf, rightName),
    );
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('diffSchemas');
    if (reach) reach.refresh();
    return { markdown: md };
  }

  async function exportErdDoc(uri, opts = {}) {
    if (!(await pro.allowed('exportErdDoc', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const bytes = await vscode.workspace.fs.readFile(target);
    const baseName = path.basename(targetPath);
    const parsed = parsePrismaSchema(Buffer.from(bytes), baseName);
    const stemRaw = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'schema';
    const defaultOut = uniquePath(path.join(path.dirname(targetPath), `${stemRaw}.dictionary.csv`));
    const saveUri = opts.outPath
      ? vscode.Uri.file(uniquePath(opts.outPath))
      : await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultOut),
        filters: { 'CSV Model Dictionary': ['csv'] },
        saveLabel: 'Save Mermaid ERD Markdown and CSV dictionary',
      });
    if (!saveUri) return undefined;

    const csvPath = uniquePath(saveUri.fsPath);
    const dir = path.dirname(csvPath);
    const stem = path.basename(csvPath, '.csv').replace(/\.dictionary$/i, '');
    const mdPath = uniquePath(path.join(dir, `${stem}.erd.md`));

    fs.writeFileSync(csvPath, buildDictionaryCsv(parsed), 'utf8');
    fs.writeFileSync(mdPath, buildErdMarkdown(parsed, baseName), 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('exportErdDoc');
    if (reach) reach.refresh();
    return { files: [csvPath, mdPath], models: parsed.stats.modelCount };
  }

  return { auditSchema, diffSchemas, exportErdDoc };
}

module.exports = { createTools, uniquePath, listPrismaFilesInDir };
