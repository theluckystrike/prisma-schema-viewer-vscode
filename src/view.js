'use strict';
// View model for Prisma Schema & ERD Inspector: pagination and filtering by block kind, findings and text.

class PrismaViewModel {
  constructor(parsed, name, fileSize) {
    this.parsed = parsed;
    this.name = name;
    this.fileSize = fileSize;
    this.filter = { text: '', kind: '' };
    this.filtered = parsed.rows.slice();
  }

  summary() {
    const p = this.parsed;
    const s = p.stats;
    return {
      name: this.name,
      fileSize: this.fileSize,
      provider: p.provider,
      totalLines: p.totalLines,
      rowCount: s.rowCount,
      datasourceCount: s.datasourceCount,
      generatorCount: s.generatorCount,
      modelCount: s.modelCount,
      enumCount: s.enumCount,
      relationCount: s.relationCount,
      indexCount: s.indexCount,
      fieldCount: s.fieldCount,
      findingErrors: s.findingErrors,
      findingWarnings: s.findingWarnings,
      relations: p.relations,
      indexes: p.indexes,
      findings: p.findings,
    };
  }

  totalCount() {
    return this.parsed.rows.length;
  }

  count() {
    return this.filtered.length;
  }

  setFilter(f) {
    const text = f && typeof f.text === 'string' ? f.text.trim().toLowerCase() : '';
    const kind = f && typeof f.kind === 'string' ? f.kind.trim() : '';
    this.filter = { text, kind };
    this.filtered = this.parsed.rows.filter((r) => {
      if (kind === 'model' && r.kind !== 'model' && r.kind !== 'view' && r.kind !== 'type') return false;
      if (kind === 'enum' && r.kind !== 'enum') return false;
      if (kind === 'config' && r.kind !== 'datasource' && r.kind !== 'generator') return false;
      if (kind === 'findings' && !r.errorCount && !r.warningCount) return false;
      if (text) {
        const hay = `${r.name} ${r.kind} ${r.signature} ${r.badge} ${r.raw}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    return this.filtered.length;
  }

  rows(from, limit) {
    const start = Math.max(0, Number(from) || 0);
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.filtered.slice(start, start + n).map((r) => ({
      index: r.index,
      line: r.line,
      name: r.name,
      kind: r.kind,
      signature: r.signature,
      badge: r.badge,
      risk: r.risk,
      errorCount: r.errorCount,
      warningCount: r.warningCount,
    }));
  }

  detail(index) {
    const r = this.parsed.rows.find((x) => x.index === index) || this.parsed.rows[0] || null;
    if (!r) return null;
    return {
      index: r.index,
      line: r.line,
      name: r.name,
      kind: r.kind,
      badge: r.badge,
      risk: r.risk,
      raw: r.raw,
      findings: r.findings,
      attrs: r.attrs,
    };
  }
}

module.exports = { PrismaViewModel };
