'use strict';
// Offline parser, relation builder, index inventory and static analyzer for Prisma schema files (*.prisma).
// Pure JavaScript, zero Prisma CLI, database or network calls.

const SCALAR_TYPES = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes', 'Unsupported',
]);

const DEPRECATED_PREVIEW_FEATURES = new Set([
  'interactivetransactions',
  'referentialintegrity',
  'orderbyrelation',
  'selectrelationcount',
  'filterjson',
  'fulltextindex',
  'extendedindexes',
  'fieldreference',
  'clientextensions',
  'deno',
  'improvedqueryraw',
  'orderByNulls'.toLowerCase(),
  'jsonprotocol',
]);

function stripLineComment(line) {
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; }
      else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
  }
  return line;
}

function parseFieldList(str) {
  const m = String(str || '').match(/\[([^\]]*)\]/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/\([^)]*\)/g, '').trim())
    .filter(Boolean);
}

function parseRelationAttr(attrText) {
  const m = attrText.match(/@relation\(([^)]*)\)/);
  if (!m) return null;
  const inner = m[1];
  const nameMatch = inner.match(/^\s*"([^"]+)"/) || inner.match(/\bname\s*:\s*"([^"]+)"/);
  const fieldsMatch = inner.match(/\bfields\s*:\s*\[([^\]]*)\]/);
  const refsMatch = inner.match(/\breferences\s*:\s*\[([^\]]*)\]/);
  const onDeleteMatch = inner.match(/\bonDelete\s*:\s*([A-Za-z]+)/);
  const onUpdateMatch = inner.match(/\bonUpdate\s*:\s*([A-Za-z]+)/);
  const mapMatch = inner.match(/\bmap\s*:\s*"([^"]+)"/);
  return {
    name: nameMatch ? nameMatch[1] : '',
    fields: fieldsMatch ? fieldsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
    references: refsMatch ? refsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
    onDelete: onDeleteMatch ? onDeleteMatch[1] : '',
    onUpdate: onUpdateMatch ? onUpdateMatch[1] : '',
    map: mapMatch ? mapMatch[1] : '',
  };
}

function parsePrismaSchema(input, fileName = 'schema.prisma') {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);

  const blocks = [];
  const findings = [];
  let inBlockComment = false;
  let current = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    let raw = lines[i];

    // Handle /* ... */ block comments
    let work = raw;
    if (inBlockComment) {
      const endIdx = work.indexOf('*/');
      if (endIdx === -1) continue;
      work = work.slice(endIdx + 2);
      inBlockComment = false;
    }
    while (work.includes('/*')) {
      const startIdx = work.indexOf('/*');
      const endIdx = work.indexOf('*/', startIdx + 2);
      if (endIdx === -1) {
        work = work.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
      work = work.slice(0, startIdx) + work.slice(endIdx + 2);
    }

    const code = stripLineComment(work).trim();
    if (!code) {
      if (current) current.rawLines.push(raw);
      continue;
    }

    if (!current) {
      const head = code.match(/^(datasource|generator|model|enum|type|view)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{(.*)$/);
      if (head) {
        current = {
          kind: head[1],
          name: head[2],
          line: lineNo,
          bodyLines: [],
          rawLines: [raw],
        };
        braceDepth = (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
        const rest = head[3].replace(/\}\s*$/, '').trim();
        if (rest) current.bodyLines.push({ line: lineNo, code: rest, raw });
        if (braceDepth <= 0) {
          blocks.push(current);
          current = null;
          braceDepth = 0;
        }
      }
      continue;
    }

    current.rawLines.push(raw);
    const opens = (code.match(/\{/g) || []).length;
    const closes = (code.match(/\}/g) || []).length;
    braceDepth += opens - closes;
    if (braceDepth <= 0) {
      const beforeClose = code.replace(/\}\s*$/, '').trim();
      if (beforeClose) current.bodyLines.push({ line: lineNo, code: beforeClose, raw });
      blocks.push(current);
      current = null;
      braceDepth = 0;
    } else {
      current.bodyLines.push({ line: lineNo, code, raw });
    }
  }
  if (current) blocks.push(current);

  const datasources = [];
  const generators = [];
  const models = [];
  const enums = [];
  const relations = [];
  const indexes = [];
  const seenNames = new Map();

  for (const b of blocks) {
    const key = `${b.kind}:${b.name}`;
    if (seenNames.has(key)) {
      findings.push({
        severity: 'error',
        category: 'schema',
        rule: 'duplicate-block-name',
        line: b.line,
        target: `${b.kind} ${b.name}`,
        message: `Duplicate ${b.kind} "${b.name}" (first declared at line ${seenNames.get(key)}).`,
      });
    } else {
      seenNames.set(key, b.line);
    }

    if (b.kind === 'datasource') {
      const props = {};
      for (const bl of b.bodyLines) {
        const kv = bl.code.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (kv) props[kv[1]] = { value: kv[2].trim(), line: bl.line };
      }
      const provider = props.provider ? props.provider.value.replace(/^["']|["']$/g, '') : 'unknown';
      const urlVal = props.url ? props.url.value : '';
      const directVal = props.directUrl ? props.directUrl.value : '';
      const ds = {
        name: b.name,
        line: b.line,
        provider,
        url: urlVal,
        directUrl: directVal,
        props,
        raw: b.rawLines.join('\n'),
      };
      datasources.push(ds);
      for (const propKey of ['url', 'directUrl', 'shadowDatabaseUrl']) {
        if (props[propKey]) {
          const val = props[propKey].value;
          if (/^["'][^"']+["']$/.test(val) && !/^env\(/i.test(val)) {
            findings.push({
              severity: 'error',
              category: 'security',
              rule: 'datasource-plaintext-url',
              line: props[propKey].line,
              target: `datasource ${b.name}.${propKey}`,
              message: `Datasource "${b.name}" hardcodes ${propKey} as a plaintext string instead of env("DATABASE_URL").`,
            });
          }
        }
      }
    } else if (b.kind === 'generator') {
      const props = {};
      for (const bl of b.bodyLines) {
        const kv = bl.code.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (kv) props[kv[1]] = { value: kv[2].trim(), line: bl.line };
      }
      const provider = props.provider ? props.provider.value.replace(/^["']|["']$/g, '') : 'unknown';
      const previewFeatures = props.previewFeatures
        ? Array.from(props.previewFeatures.value.matchAll(/["']([^"']+)["']/g)).map((m) => m[1])
        : [];
      const gen = {
        name: b.name,
        line: b.line,
        provider,
        output: props.output ? props.output.value.replace(/^["']|["']$/g, '') : '',
        previewFeatures,
        props,
        raw: b.rawLines.join('\n'),
      };
      generators.push(gen);
      for (const pf of previewFeatures) {
        if (DEPRECATED_PREVIEW_FEATURES.has(pf.toLowerCase())) {
          findings.push({
            severity: 'warning',
            category: 'deprecation',
            rule: 'deprecated-preview-feature',
            line: props.previewFeatures ? props.previewFeatures.line : b.line,
            target: `generator ${b.name}`,
            message: `Generator "${b.name}" enables deprecated or already-GA previewFeature "${pf}".`,
          });
        }
      }
    } else if (b.kind === 'enum') {
      const values = [];
      let mapName = '';
      for (const bl of b.bodyLines) {
        if (bl.code.startsWith('@@map')) {
          const mm = bl.code.match(/@@map\(\s*"([^"]+)"\s*\)/);
          if (mm) mapName = mm[1];
          continue;
        }
        const vm = bl.code.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (vm) values.push({ name: vm[1], line: bl.line });
      }
      enums.push({
        name: b.name,
        line: b.line,
        values,
        mapName,
        raw: b.rawLines.join('\n'),
      });
      if (values.length === 0) {
        findings.push({
          severity: 'warning',
          category: 'schema',
          rule: 'empty-enum',
          line: b.line,
          target: `enum ${b.name}`,
          message: `Enum "${b.name}" declares zero values.`,
        });
      }
    } else if (b.kind === 'model' || b.kind === 'view' || b.kind === 'type') {
      const fields = [];
      const blockIndexes = [];
      let hasBlockId = false;
      let hasBlockUnique = false;
      let mapName = '';

      for (const bl of b.bodyLines) {
        if (bl.code.startsWith('@@')) {
          const kindMatch = bl.code.match(/^@@([A-Za-z]+)/);
          const attrKind = kindMatch ? `@@${kindMatch[1]}` : '@@attr';
          const cols = parseFieldList(bl.code);
          const mm = bl.code.match(/\bmap\s*:\s*"([^"]+)"/) || (attrKind === '@@map' ? bl.code.match(/@@map\(\s*"([^"]+)"\s*\)/) : null);
          if (attrKind === '@@map' && mm) {
            mapName = mm[1];
          } else if (attrKind === '@@id' || attrKind === '@@unique' || attrKind === '@@index') {
            if (attrKind === '@@id') hasBlockId = true;
            if (attrKind === '@@unique') hasBlockUnique = true;
            const idxEntry = {
              model: b.name,
              kind: attrKind,
              fields: cols,
              mapName: mm ? mm[1] : '',
              line: bl.line,
            };
            blockIndexes.push(idxEntry);
            indexes.push(idxEntry);
          }
          continue;
        }

        const fm = bl.code.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)(\[\]|\?)?(.*)$/);
        if (!fm) continue;
        const fieldName = fm[1];
        const baseType = fm[2].replace(/\([^)]*\)$/, '');
        const mod = fm[3] || '';
        const rest = fm[4] || '';
        const isList = mod === '[]';
        const isOptional = mod === '?';
        const isId = /@id\b/.test(rest);
        const isUnique = /@unique\b/.test(rest);
        const isUpdatedAt = /@updatedAt\b/.test(rest);
        const defMatch = rest.match(/@default\(([^)]*(?:\([^)]*\)[^)]*)*)\)/);
        const mapMatch = rest.match(/@map\(\s*"([^"]+)"\s*\)/);
        const rel = parseRelationAttr(rest);

        if (isId) {
          indexes.push({ model: b.name, kind: '@id', fields: [fieldName], mapName: '', line: bl.line });
        } else if (isUnique) {
          indexes.push({ model: b.name, kind: '@unique', fields: [fieldName], mapName: '', line: bl.line });
        }

        fields.push({
          name: fieldName,
          type: baseType,
          isList,
          isOptional,
          isScalar: SCALAR_TYPES.has(baseType),
          isId,
          isUnique,
          isUpdatedAt,
          defaultVal: defMatch ? defMatch[1].trim() : '',
          mapName: mapMatch ? mapMatch[1] : '',
          relation: rel,
          attrsRaw: rest.trim(),
          line: bl.line,
        });
      }

      models.push({
        kind: b.kind,
        name: b.name,
        line: b.line,
        fields,
        blockIndexes,
        hasId: hasBlockId || fields.some((f) => f.isId),
        hasUnique: hasBlockUnique || fields.some((f) => f.isUnique),
        mapName,
        raw: b.rawLines.join('\n'),
      });

      if (fields.length === 0) {
        findings.push({
          severity: 'warning',
          category: 'schema',
          rule: 'empty-model',
          line: b.line,
          target: `${b.kind} ${b.name}`,
          message: `${b.kind} "${b.name}" declares zero fields.`,
        });
      } else if (b.kind === 'model' && !hasBlockId && !fields.some((f) => f.isId) && !hasBlockUnique && !fields.some((f) => f.isUnique)) {
        findings.push({
          severity: 'error',
          category: 'integrity',
          rule: 'model-missing-id',
          line: b.line,
          target: `model ${b.name}`,
          message: `Model "${b.name}" has no @id, @@id, @unique or @@unique identifier.`,
        });
      }
    }
  }

  const modelNames = new Set(models.map((m) => m.name));
  const enumNames = new Set(enums.map((e) => e.name));

  // Build leading-indexed-column map per model for FK index check
  const indexedPrefixes = new Map();
  for (const idx of indexes) {
    if (!indexedPrefixes.has(idx.model)) indexedPrefixes.set(idx.model, new Set());
    if (idx.fields.length) {
      indexedPrefixes.get(idx.model).add(idx.fields[0]);
      indexedPrefixes.get(idx.model).add(idx.fields.join(','));
    }
  }

  // Build relations table and run relation findings
  for (const m of models) {
    const modelIndexed = indexedPrefixes.get(m.name) || new Set();
    for (const f of m.fields) {
      if (f.isScalar || enumNames.has(f.type)) continue;
      if (!modelNames.has(f.type) && !f.relation) continue;
      const rel = f.relation;
      const fkFields = rel ? rel.fields : [];
      const refs = rel ? rel.references : [];
      const hasFk = fkFields.length > 0;

      // Determine cardinality
      let cardinality = '1:N';
      if (f.isList) {
        const targetModel = models.find((x) => x.name === f.type);
        const reverseList = targetModel && targetModel.fields.some((rf) => rf.type === m.name && rf.isList);
        cardinality = reverseList ? 'M:N' : '1:N';
      } else if (hasFk) {
        const fkFieldObj = fkFields.length === 1 ? m.fields.find((x) => x.name === fkFields[0]) : null;
        cardinality = (fkFieldObj && (fkFieldObj.isUnique || fkFieldObj.isId)) ? '1:1' : 'N:1';
      } else {
        cardinality = '1:1';
      }

      const fkCovered = !hasFk || modelIndexed.has(fkFields[0]) || modelIndexed.has(fkFields.join(','));

      relations.push({
        fromModel: m.name,
        fromField: f.name,
        toModel: f.type,
        cardinality,
        fields: fkFields,
        references: refs,
        onDelete: rel ? rel.onDelete : '',
        onUpdate: rel ? rel.onUpdate : '',
        relationName: rel ? rel.name : '',
        indexed: hasFk ? fkCovered : true,
        hasFk,
        line: f.line,
      });

      if (hasFk && !fkCovered) {
        findings.push({
          severity: 'warning',
          category: 'performance',
          rule: 'fk-missing-index',
          line: f.line,
          target: `${m.name}.${f.name}`,
          message: `Foreign key [${fkFields.join(', ')}] on "${m.name}.${f.name}" -> "${f.type}" has no matching @@index or @unique.`,
        });
      }

      if (rel && rel.onDelete === 'Cascade') {
        findings.push({
          severity: 'warning',
          category: 'safety',
          rule: 'cascade-delete-hazard',
          line: f.line,
          target: `${m.name}.${f.name}`,
          message: `Relation "${m.name}.${f.name}" -> "${f.type}" uses onDelete: Cascade; deleting a parent "${f.type}" will delete child "${m.name}" rows.`,
        });
      }
    }
  }

  // Build unified rows for the inspector table
  const rows = [];
  let rowIndex = 0;

  const findingsForTarget = (prefix) => findings.filter((x) => x.target === prefix || x.target.startsWith(`${prefix}.`) || x.target === `model ${prefix}` || x.target === `enum ${prefix}` || x.target === `datasource ${prefix}` || x.target === `generator ${prefix}`);

  for (const ds of datasources) {
    rowIndex += 1;
    const rf = findingsForTarget(`datasource ${ds.name}`);
    const errC = rf.filter((x) => x.severity === 'error').length;
    const warnC = rf.filter((x) => x.severity === 'warning').length;
    rows.push({
      index: rowIndex,
      line: ds.line,
      kind: 'datasource',
      name: ds.name,
      signature: `provider=${ds.provider} · url=${ds.url || '(unset)'}`,
      badge: ds.provider,
      risk: errC ? `${errC} error(s)` : (warnC ? `${warnC} warning(s)` : 'OK'),
      errorCount: errC,
      warningCount: warnC,
      findings: rf,
      attrs: Object.entries(ds.props).map(([k, v]) => ({ key: k, value: v.value })),
      raw: ds.raw,
    });
  }

  for (const gen of generators) {
    rowIndex += 1;
    const rf = findingsForTarget(`generator ${gen.name}`);
    const errC = rf.filter((x) => x.severity === 'error').length;
    const warnC = rf.filter((x) => x.severity === 'warning').length;
    rows.push({
      index: rowIndex,
      line: gen.line,
      kind: 'generator',
      name: gen.name,
      signature: `provider=${gen.provider}${gen.previewFeatures.length ? ` · preview=[${gen.previewFeatures.join(', ')}]` : ''}`,
      badge: gen.previewFeatures.length ? `${gen.previewFeatures.length} preview` : 'generator',
      risk: errC ? `${errC} error(s)` : (warnC ? `${warnC} warning(s)` : 'OK'),
      errorCount: errC,
      warningCount: warnC,
      findings: rf,
      attrs: Object.entries(gen.props).map(([k, v]) => ({ key: k, value: v.value })),
      raw: gen.raw,
    });
  }

  for (const m of models) {
    rowIndex += 1;
    const rf = findingsForTarget(m.name);
    const errC = rf.filter((x) => x.severity === 'error').length;
    const warnC = rf.filter((x) => x.severity === 'warning').length;
    const relCount = relations.filter((r) => r.fromModel === m.name).length;
    const idxCount = indexes.filter((ix) => ix.model === m.name).length;
    const attrs = m.fields.map((f) => ({
      key: `${f.name}`,
      value: `${f.type}${f.isList ? '[]' : (f.isOptional ? '?' : '')}${f.attrsRaw ? ` ${f.attrsRaw}` : ''}`,
    }));
    if (m.mapName) attrs.unshift({ key: '@@map', value: m.mapName });
    rows.push({
      index: rowIndex,
      line: m.line,
      kind: m.kind,
      name: m.name,
      signature: `${m.fields.length} fields · ${relCount} relations · ${idxCount} indexes/keys`,
      badge: m.hasId ? 'has @id' : 'no @id',
      risk: errC ? `${errC} error(s)` : (warnC ? `${warnC} warning(s)` : 'OK'),
      errorCount: errC,
      warningCount: warnC,
      findings: rf,
      attrs,
      raw: m.raw,
    });
  }

  for (const en of enums) {
    rowIndex += 1;
    const rf = findingsForTarget(`enum ${en.name}`);
    const errC = rf.filter((x) => x.severity === 'error').length;
    const warnC = rf.filter((x) => x.severity === 'warning').length;
    rows.push({
      index: rowIndex,
      line: en.line,
      kind: 'enum',
      name: en.name,
      signature: `${en.values.length} values: ${en.values.slice(0, 5).map((v) => v.name).join(', ')}${en.values.length > 5 ? ', ...' : ''}`,
      badge: `${en.values.length} values`,
      risk: errC ? `${errC} error(s)` : (warnC ? `${warnC} warning(s)` : 'OK'),
      errorCount: errC,
      warningCount: warnC,
      findings: rf,
      attrs: en.values.map((v, idx) => ({ key: `#${idx + 1}`, value: v.name })),
      raw: en.raw,
    });
  }

  // Attach rowIndex to relations for click-to-detail navigation
  const modelRowMap = new Map(rows.filter((r) => r.kind === 'model' || r.kind === 'view' || r.kind === 'type').map((r) => [r.name, r.index]));
  for (const r of relations) r.rowIndex = modelRowMap.get(r.fromModel) || 1;
  for (const ix of indexes) ix.rowIndex = modelRowMap.get(ix.model) || 1;

  const findingErrors = findings.filter((x) => x.severity === 'error').length;
  const findingWarnings = findings.filter((x) => x.severity === 'warning').length;

  return {
    fileName,
    totalLines: lines.length,
    provider: datasources[0] ? datasources[0].provider : 'unspecified',
    datasources,
    generators,
    models,
    enums,
    relations,
    indexes,
    findings,
    rows,
    stats: {
      rowCount: rows.length,
      datasourceCount: datasources.length,
      generatorCount: generators.length,
      modelCount: models.length,
      enumCount: enums.length,
      relationCount: relations.length,
      indexCount: indexes.length,
      fieldCount: models.reduce((a, m) => a + m.fields.length, 0),
      findingErrors,
      findingWarnings,
    },
  };
}

function buildAuditMarkdown(entries) {
  const lines = ['# Prisma Schema Performance & Relation-Safety Audit', ''];
  lines.push(`Generated offline from ${entries.length} Prisma schema file(s). No Prisma CLI or database connections were made.`, '');
  lines.push('## Summary', '');
  lines.push('| File | Provider | Models | Enums | Relations | Indexes | Errors | Warnings |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const { fileName, parsed } of entries) {
    const s = parsed.stats;
    lines.push(`| ${fileName} | ${parsed.provider} | ${s.modelCount} | ${s.enumCount} | ${s.relationCount} | ${s.indexCount} | ${s.findingErrors} | ${s.findingWarnings} |`);
  }
  lines.push('');

  for (const { fileName, parsed } of entries) {
    lines.push(`## ${fileName}`, '');
    if (parsed.findings.length) {
      lines.push('### Findings', '');
      lines.push('| Severity | Rule | Line | Target | Detail |');
      lines.push('| --- | --- | ---: | --- | --- |');
      for (const f of parsed.findings) {
        lines.push(`| ${f.severity.toUpperCase()} | \`${f.rule}\` | ${f.line} | \`${f.target}\` | ${f.message} |`);
      }
      lines.push('');
    } else {
      lines.push('No static schema, index or relation-safety findings.', '');
    }

    if (parsed.relations.length) {
      lines.push('### Relation Matrix', '');
      lines.push('| From | To | Card | FK Fields | onDelete | Indexed |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const r of parsed.relations) {
        lines.push(`| \`${r.fromModel}.${r.fromField}\` | \`${r.toModel}\` | ${r.cardinality} | ${r.fields.join(', ') || '-'} | ${r.onDelete || '-'} | ${r.hasFk ? (r.indexed ? 'Yes' : 'NO') : 'N/A'} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function buildDiffMarkdown(leftName, left, rightName, right) {
  const lines = [`# Prisma Schema Diff: ${leftName} vs ${rightName}`, ''];
  const breaking = [];
  const additive = [];
  const modified = [];

  const leftModels = new Map(left.models.map((m) => [m.name, m]));
  const rightModels = new Map(right.models.map((m) => [m.name, m]));

  for (const [name, lm] of leftModels) {
    if (!rightModels.has(name)) {
      breaking.push(`Removed model \`${name}\` (${lm.fields.length} fields)`);
      continue;
    }
    const rm = rightModels.get(name);
    const lfMap = new Map(lm.fields.map((f) => [f.name, f]));
    const rfMap = new Map(rm.fields.map((f) => [f.name, f]));
    for (const [fn, lf] of lfMap) {
      if (!rfMap.has(fn)) {
        breaking.push(`Removed field \`${name}.${fn}\` (${lf.type})`);
      } else {
        const rf = rfMap.get(fn);
        if (lf.type !== rf.type || lf.isList !== rf.isList) {
          breaking.push(`Changed type of \`${name}.${fn}\`: \`${lf.type}${lf.isList ? '[]' : ''}\` -> \`${rf.type}${rf.isList ? '[]' : ''}\``);
        } else if (lf.isOptional && !rf.isOptional) {
          breaking.push(`Tightened nullability of \`${name}.${fn}\` (optional -> required)`);
        } else if (!lf.isOptional && rf.isOptional) {
          modified.push(`Relaxed nullability of \`${name}.${fn}\` (required -> optional)`);
        }
        const lDel = lf.relation ? lf.relation.onDelete : '';
        const rDel = rf.relation ? rf.relation.onDelete : '';
        if (lDel !== rDel) {
          modified.push(`Changed onDelete on \`${name}.${fn}\`: \`${lDel || 'default'}\` -> \`${rDel || 'default'}\``);
        }
      }
    }
    for (const [fn, rf] of rfMap) {
      if (!lfMap.has(fn)) {
        if (!rf.isOptional && !rf.isList && !rf.defaultVal && rf.isScalar) {
          breaking.push(`Added required field without @default: \`${name}.${fn}\` (${rf.type})`);
        } else {
          additive.push(`Added field \`${name}.${fn}\` (${rf.type}${rf.isList ? '[]' : (rf.isOptional ? '?' : '')})`);
        }
      }
    }
  }
  for (const [name, rm] of rightModels) {
    if (!leftModels.has(name)) additive.push(`Added model \`${name}\` (${rm.fields.length} fields)`);
  }

  const leftEnums = new Map(left.enums.map((e) => [e.name, new Set(e.values.map((v) => v.name))]));
  const rightEnums = new Map(right.enums.map((e) => [e.name, new Set(e.values.map((v) => v.name))]));
  for (const [en, lv] of leftEnums) {
    if (!rightEnums.has(en)) {
      breaking.push(`Removed enum \`${en}\``);
    } else {
      const rv = rightEnums.get(en);
      for (const v of lv) if (!rv.has(v)) breaking.push(`Removed enum value \`${en}.${v}\``);
      for (const v of rv) if (!lv.has(v)) additive.push(`Added enum value \`${en}.${v}\``);
    }
  }
  for (const [en] of rightEnums) {
    if (!leftEnums.has(en)) additive.push(`Added enum \`${en}\``);
  }

  lines.push('| Metric | Baseline | Comparison | Delta |');
  lines.push('| --- | ---: | ---: | ---: |');
  const metrics = [
    ['Models', left.stats.modelCount, right.stats.modelCount],
    ['Enums', left.stats.enumCount, right.stats.enumCount],
    ['Fields', left.stats.fieldCount, right.stats.fieldCount],
    ['Relations', left.stats.relationCount, right.stats.relationCount],
    ['Indexes/Keys', left.stats.indexCount, right.stats.indexCount],
    ['Errors', left.stats.findingErrors, right.stats.findingErrors],
    ['Warnings', left.stats.findingWarnings, right.stats.findingWarnings],
  ];
  for (const [label, a, b] of metrics) {
    const d = b - a;
    lines.push(`| ${label} | ${a} | ${b} | ${d >= 0 ? `+${d}` : d} |`);
  }
  lines.push('');

  lines.push(`## Breaking Changes (${breaking.length})`, '');
  lines.push(...(breaking.length ? breaking.map((x) => `- ${x}`) : ['- None detected.']), '');

  lines.push(`## Additive Changes (${additive.length})`, '');
  lines.push(...(additive.length ? additive.map((x) => `- ${x}`) : ['- None detected.']), '');

  lines.push(`## Other Modifications (${modified.length})`, '');
  lines.push(...(modified.length ? modified.map((x) => `- ${x}`) : ['- None detected.']), '');

  return lines.join('\n');
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildDictionaryCsv(parsed) {
  const rows = [['Model', 'Field', 'Type', 'Nullable', 'List', 'Key', 'Default', 'RelationTarget', 'OnDelete', 'Line']];
  for (const m of parsed.models) {
    for (const f of m.fields) {
      const key = f.isId ? 'PK' : (f.isUnique ? 'UNIQUE' : (f.relation && f.relation.fields.length ? 'FK' : ''));
      rows.push([
        m.name,
        f.name,
        f.type,
        f.isOptional ? 'yes' : 'no',
        f.isList ? 'yes' : 'no',
        key,
        f.defaultVal,
        f.relation ? f.type : '',
        f.relation ? f.relation.onDelete : '',
        f.line,
      ]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

function buildErdMarkdown(parsed, fileName) {
  const lines = [`# Prisma ERD & Model Dictionary: ${fileName}`, ''];
  lines.push('```mermaid', 'erDiagram');
  for (const m of parsed.models) {
    lines.push(`  ${m.name} {`);
    for (const f of m.fields) {
      if (!f.isScalar && !parsed.enums.some((e) => e.name === f.type)) continue;
      const keyTag = f.isId ? ' PK' : (f.isUnique ? ' UK' : '');
      lines.push(`    ${f.type}${f.isList ? '_list' : ''} ${f.name}${keyTag}`);
    }
    lines.push('  }');
  }
  const seenEdges = new Set();
  for (const r of parsed.relations) {
    if (!r.hasFk && r.cardinality !== 'M:N') continue;
    const edgeKey = `${r.toModel}->${r.fromModel}:${r.fromField}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    const sym = r.cardinality === '1:1' ? '||--o|' : (r.cardinality === 'M:N' ? '}o--o{' : '||--o{');
    lines.push(`  ${r.toModel} ${sym} ${r.fromModel} : "${r.fromField}"`);
  }
  lines.push('```', '');

  lines.push('## Models', '');
  for (const m of parsed.models) {
    lines.push(`### ${m.name}`, '');
    lines.push('| Field | Type | Modifiers | Attributes |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of m.fields) {
      const mod = f.isList ? 'list' : (f.isOptional ? 'optional' : 'required');
      lines.push(`| \`${f.name}\` | \`${f.type}\` | ${mod} | \`${f.attrsRaw || '-'}\` |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  parsePrismaSchema,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildDictionaryCsv,
  buildErdMarkdown,
  SCALAR_TYPES,
  DEPRECATED_PREVIEW_FEATURES,
};
