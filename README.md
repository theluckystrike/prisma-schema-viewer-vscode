# Prisma Schema & ERD Inspector for VS Code

Inspect `schema.prisma` and `*.prisma` files in VS Code without running the Prisma CLI, connecting to a database or calling any cloud service. Large Prisma schemas often hide unindexed foreign keys, aggressive `onDelete: Cascade` chains, hardcoded datasource URLs, models missing `@id` or deprecated generator `previewFeatures`. This extension parses Prisma schemas locally in plain JavaScript with zero external binaries or network calls.

![Prisma Schema & ERD Inspector showing datasource, generator, model, enum and relation breakdown with index coverage and static schema findings](images/screenshot.png)

## What it opens

- `schema.prisma` files in any folder or monorepo package.
- Any `*.prisma` multi-file schema fragment.
- Any matching file via the Command Palette or Explorer context menu (Open in Prisma Schema & ERD Inspector).
- Nothing to install, no Prisma CLI or database connection required, no cloud or network calls.

## The free part

- Datasource, generator, model and enum explorer: parses `datasource`, `generator`, `model`, `enum`, `view` and `type` blocks with line numbers, field types, defaults and block attributes.
- Visual model-relationship table: lists every `@relation` edge with source model, target model, cardinality (`1:1`, `1:N`, `M:N`), foreign-key fields, references, `onDelete` / `onUpdate` actions and index coverage.
- Index and unique constraint viewer: inventories every `@id`, `@@id`, `@unique`, `@@unique` and `@@index` across all models in one searchable table.
- Static schema findings: flags missing `@@index` on foreign-key columns, `onDelete: Cascade` deletion hazards, plaintext datasource URLs instead of `env(...)`, models missing `@id`, deprecated `previewFeatures`, empty blocks and duplicate declarations.

## The Pro tools, with 1 free try

Pro adds the schema audit, schema diff and Mermaid ERD export steps: generate a Markdown Prisma performance and relation-safety audit for one schema or a folder, compare two `.prisma` files in Markdown for breaking model, field, enum and relation changes, or export a Mermaid ERD Markdown document and CSV model dictionary locally. Your first try of each Pro tool is free. Zovo Pro is USD 19 once, and the team licence is USD 59.

## Why not plain text

Reading a 600-line `schema.prisma` file in plain text makes it easy to miss an unindexed foreign key, a cascade-delete chain across billing tables, a hardcoded staging database URL or a deprecated preview flag. A local inspector puts the models, relations, indexes and static findings on one screen.

## More tools by Zovo

See full docs and install options at [vscode.zovo.one/extensions/zovo-prisma-schema-viewer/](https://vscode.zovo.one/extensions/zovo-prisma-schema-viewer/), browse all Zovo VS Code extensions at [vscode.zovo.one](https://vscode.zovo.one/), or explore [Zovo Pro](https://vscode.zovo.one/pro/).
