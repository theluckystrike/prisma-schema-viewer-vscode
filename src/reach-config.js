'use strict';
module.exports = {
  prefix: 'zovoPrismaview',
  triesKey: 'zovoPrismaview.proTrial',
  slot: '#protools',
  tools: [
    { id: 'auditSchema', title: 'Audit Prisma schema and relations', command: 'zovoPrismaview.auditSchema' },
    { id: 'diffSchemas', title: 'Compare two Prisma schemas', command: 'zovoPrismaview.diffSchemas' },
    { id: 'exportErdDoc', title: 'Export Mermaid ERD and dictionary', command: 'zovoPrismaview.exportErdDoc' },
  ],
};
