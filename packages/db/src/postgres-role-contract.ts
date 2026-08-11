import type { Sql } from 'postgres'

export const POSTGRES_SCHEMA_PRIVILEGES = ['USAGE', 'CREATE'] as const

export const POSTGRES_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const

export const POSTGRES_COLUMN_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'REFERENCES',
] as const

export const POSTGRES_SEQUENCE_PRIVILEGES = [
  'SELECT',
  'USAGE',
  'UPDATE',
] as const

export type PostgresSchemaPrivilege = typeof POSTGRES_SCHEMA_PRIVILEGES[number]
export type PostgresTablePrivilege = typeof POSTGRES_TABLE_PRIVILEGES[number]
export type PostgresColumnPrivilege = typeof POSTGRES_COLUMN_PRIVILEGES[number]
export type PostgresSequencePrivilege = typeof POSTGRES_SEQUENCE_PRIVILEGES[number]

export type PostgresRoleContract = {
  key: string
  bypassRls: boolean
  schemaPrivileges?: Readonly<Record<string, readonly PostgresSchemaPrivilege[]>>
  /** Unqualified object names are resolved in public. */
  tablePrivileges: Readonly<Record<string, readonly PostgresTablePrivilege[]>>
  /** Column names use PostgreSQL snake_case; unqualified tables resolve in public. */
  columnPrivileges?: Readonly<
    Record<string, Readonly<Record<string, readonly PostgresColumnPrivilege[]>>>
  >
  /** Unqualified object names are resolved in public. */
  sequencePrivileges: Readonly<Record<string, readonly PostgresSequencePrivilege[]>>
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      'PostgreSQL identifiers must be lowercase and contain at most 63 letters, digits, or underscores',
    )
  }
  return `"${value}"`
}

function quoteDatabaseIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

type QualifiedObject = { schema: string; name: string; key: string }

function qualifiedObject(value: string): QualifiedObject {
  const parts = value.split('.')
  if (parts.length > 2 || parts.some((part) => !IDENTIFIER_PATTERN.test(part))) {
    throw new Error(`Invalid PostgreSQL object name: ${value}`)
  }
  const [schema, name] = parts.length === 1 ? ['public', parts[0]!] : parts
  return { schema: schema!, name: name!, key: value }
}

function schemaPrivileges(
  contract: PostgresRoleContract,
): Readonly<Record<string, readonly PostgresSchemaPrivilege[]>> {
  return contract.schemaPrivileges ?? { public: ['USAGE'] }
}

function managedSchemas(contract: PostgresRoleContract): string[] {
  const schemas = new Set(Object.keys(schemaPrivileges(contract)))
  for (const object of [
    ...Object.keys(contract.tablePrivileges),
    ...Object.keys(contract.columnPrivileges ?? {}),
    ...Object.keys(contract.sequencePrivileges),
  ]) {
    schemas.add(qualifiedObject(object).schema)
  }
  const values = [...schemas].sort()
  for (const schema of values) quoteIdentifier(schema)
  return values
}

function qualifiedSqlName(value: string): string {
  const object = qualifiedObject(value)
  return `${object.schema}.${object.name}`
}

function groupObjectsByPrivileges<T extends string>(
  privilegesByObject: Readonly<Record<string, readonly T[]>>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const [object, privileges] of Object.entries(privilegesByObject)) {
    qualifiedObject(object)
    const key = [...privileges].sort().join(', ')
    groups.set(key, [...(groups.get(key) ?? []), object])
  }
  return groups
}

function columnGrantStatements(
  contract: PostgresRoleContract,
  role: string,
): string[] {
  const statements: string[] = []
  for (const [table, privilegesByColumn] of Object.entries(
    contract.columnPrivileges ?? {},
  )) {
    const groups = groupObjectsByPrivileges(privilegesByColumn)
    const qualifiedTable = qualifiedSqlName(table)
    for (const [privileges, columns] of groups) {
      if (!privileges) continue
      for (const column of columns) quoteIdentifier(column)
      statements.push(
        `GRANT ${privileges} (${columns.join(', ')}) ON TABLE ${qualifiedTable} TO ${role}`,
      )
    }
  }
  return statements
}

export function postgresRoleProvisioningStatements(
  contract: PostgresRoleContract,
  roleName: string,
): string[] {
  const role = quoteIdentifier(roleName)
  const rlsAttribute = contract.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'
  const statements = [
    `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT ${rlsAttribute} NOREPLICATION`,
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
  ]
  const expectedSchemaPrivileges = schemaPrivileges(contract)
  for (const schema of managedSchemas(contract)) {
    quoteIdentifier(schema)
    statements.push(
      `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`,
    )
    const privileges = expectedSchemaPrivileges[schema] ?? []
    if (privileges.length > 0) {
      statements.push(
        `GRANT ${[...privileges].sort().join(', ')} ON SCHEMA ${schema} TO ${role}`,
      )
    }
  }
  for (const [privileges, tables] of groupObjectsByPrivileges(contract.tablePrivileges)) {
    if (!privileges) continue
    statements.push(
      `GRANT ${privileges} ON TABLE ${tables.map(qualifiedSqlName).join(', ')} TO ${role}`,
    )
  }
  statements.push(...columnGrantStatements(contract, role))
  for (const [privileges, sequences] of groupObjectsByPrivileges(contract.sequencePrivileges)) {
    if (!privileges) continue
    statements.push(
      `GRANT ${privileges} ON SEQUENCE ${sequences.map(qualifiedSqlName).join(', ')} TO ${role}`,
    )
  }
  return statements
}

export async function provisionPostgresRole(
  client: Sql,
  contract: PostgresRoleContract,
  roleName: string,
): Promise<void> {
  const statements = postgresRoleProvisioningStatements(contract, roleName)
  const firstObjectGrant = statements.findIndex(
    (statement) => statement.startsWith('GRANT ') &&
      (statement.includes(' ON TABLE ') || statement.includes(' ON SEQUENCE ')),
  )
  const resetStatements = firstObjectGrant === -1
    ? statements
    : statements.slice(0, firstObjectGrant)
  const grantStatements = firstObjectGrant === -1
    ? []
    : statements.slice(firstObjectGrant)
  for (const statement of resetStatements) {
    await client.unsafe(statement)
  }
  const role = quoteIdentifier(roleName)
  const schemas = managedSchemas(contract)
  const tables = await client<{
    schemaName: string
    tableName: string
    columns: string[]
  }[]>`
    SELECT
      columns.table_schema AS "schemaName",
      columns.table_name AS "tableName",
      array_agg(columns.column_name ORDER BY columns.ordinal_position) AS columns
    FROM information_schema.columns columns
    WHERE columns.table_schema = ANY(${schemas})
    GROUP BY columns.table_schema, columns.table_name
  `
  for (const table of tables) {
    if (table.columns.length === 0) continue
    await client.unsafe(
      `REVOKE ALL (${table.columns.map(quoteDatabaseIdentifier).join(', ')}) ` +
      `ON TABLE ${quoteDatabaseIdentifier(table.schemaName)}.` +
      `${quoteDatabaseIdentifier(table.tableName)} FROM ${role}`,
    )
  }
  for (const statement of grantStatements) {
    await client.unsafe(statement)
  }
}

export type PostgresRoleAttributes = {
  roleName: string
  superuser: boolean
  inherit: boolean
  createRole: boolean
  createDatabase: boolean
  canLogin: boolean
  replication: boolean
  bypassRls: boolean
}

export type PostgresRoleVerification = {
  contractKey: string
  role: PostgresRoleAttributes | null
  schemaPrivileges: string[]
  tablePrivileges: string[]
  columnPrivileges: string[]
  sequencePrivileges: string[]
  issues: string[]
}

function expectedSchemaPrivileges(contract: PostgresRoleContract): string[] {
  return Object.entries(schemaPrivileges(contract))
    .flatMap(([schema, privileges]) => {
      quoteIdentifier(schema)
      return privileges.map((privilege) => `${schema}:${privilege}`)
    })
    .sort()
}

function expectedObjectPrivileges<T extends string>(
  privilegesByObject: Readonly<Record<string, readonly T[]>>,
): string[] {
  return Object.entries(privilegesByObject)
    .flatMap(([object, privileges]) => {
      const qualified = qualifiedObject(object)
      return privileges.map(
        (privilege) => `${qualified.schema}.${qualified.name}:${privilege}`,
      )
    })
    .sort()
}

function expectedColumnPrivileges(contract: PostgresRoleContract): string[] {
  return Object.entries(contract.columnPrivileges ?? {})
    .flatMap(([table, privilegesByColumn]) => {
      const qualified = qualifiedObject(table)
      return Object.entries(privilegesByColumn).flatMap(([column, privileges]) => {
        quoteIdentifier(column)
        return privileges.map(
          (privilege) =>
            `${qualified.schema}.${qualified.name}.${column}:${privilege}`,
        )
      })
    })
    .sort()
}

function compareExact(label: string, actual: string[], expected: string[]): string[] {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.filter((entry) => !actualSet.has(entry))
  const extra = actual.filter((entry) => !expectedSet.has(entry))
  return [
    ...(missing.length > 0 ? [`Missing ${label}: ${missing.join(', ')}`] : []),
    ...(extra.length > 0 ? [`Unexpected ${label}: ${extra.join(', ')}`] : []),
  ]
}

export async function verifyCurrentPostgresRole(
  client: Sql,
  contract: PostgresRoleContract,
  expectedRoleName: string,
): Promise<PostgresRoleVerification> {
  quoteIdentifier(expectedRoleName)
  const schemas = managedSchemas(contract)
  const [role] = await client<PostgresRoleAttributes[]>`
    SELECT
      rolname AS "roleName",
      rolsuper AS "superuser",
      rolinherit AS "inherit",
      rolcreaterole AS "createRole",
      rolcreatedb AS "createDatabase",
      rolcanlogin AS "canLogin",
      rolreplication AS "replication",
      rolbypassrls AS "bypassRls"
    FROM pg_roles
    WHERE rolname = current_user
  `
  const schemaRows = await client<{ schemaName: string; privilege: string }[]>`
    SELECT schemas.schema_name AS "schemaName", privileges.privilege
    FROM information_schema.schemata schemas
    CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']::text[]) AS privileges(privilege)
    WHERE schemas.schema_name = ANY(${schemas})
      AND has_schema_privilege(current_user, schemas.schema_name, privileges.privilege)
  `
  const tableRows = await client<{
    schemaName: string
    tableName: string
    privilege: string
  }[]>`
    SELECT
      tables.schemaname AS "schemaName",
      tables.tablename AS "tableName",
      privileges.privilege
    FROM pg_tables tables
    CROSS JOIN unnest(ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]) AS privileges(privilege)
    WHERE tables.schemaname = ANY(${schemas})
      AND has_table_privilege(
        current_user,
        format('%I.%I', tables.schemaname, tables.tablename),
        privileges.privilege
      )
  `
  const sequenceRows = await client<{
    schemaName: string
    sequenceName: string
    privilege: string
  }[]>`
    SELECT
      sequences.schemaname AS "schemaName",
      sequences.sequencename AS "sequenceName",
      privileges.privilege
    FROM pg_sequences sequences
    CROSS JOIN unnest(ARRAY['SELECT', 'USAGE', 'UPDATE']::text[]) AS privileges(privilege)
    WHERE sequences.schemaname = ANY(${schemas})
      AND has_sequence_privilege(
        current_user,
        format('%I.%I', sequences.schemaname, sequences.sequencename),
        privileges.privilege
      )
  `
  const columnRows = await client<{
    schemaName: string
    tableName: string
    columnName: string
    privilege: string
  }[]>`
    SELECT
      columns.table_schema AS "schemaName",
      columns.table_name AS "tableName",
      columns.column_name AS "columnName",
      privileges.privilege
    FROM information_schema.columns columns
    CROSS JOIN unnest(ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
    ]::text[]) AS privileges(privilege)
    WHERE columns.table_schema = ANY(${schemas})
      AND has_column_privilege(
        current_user,
        format('%I.%I', columns.table_schema, columns.table_name),
        columns.column_name,
        privileges.privilege
      )
      AND NOT has_table_privilege(
        current_user,
        format('%I.%I', columns.table_schema, columns.table_name),
        privileges.privilege
      )
  `
  const [boundary] = await client<{
    memberOfCount: number
    ownedObjectCount: number
    ownsDatabase: boolean
  }[]>`
    SELECT
      (
        SELECT count(*)::integer
        FROM pg_auth_members memberships
        INNER JOIN pg_roles member ON member.oid = memberships.member
        WHERE member.rolname = current_user
      ) AS "memberOfCount",
      (
        SELECT count(*)::integer
        FROM pg_class objects
        INNER JOIN pg_namespace namespaces ON namespaces.oid = objects.relnamespace
        INNER JOIN pg_roles owner ON owner.oid = objects.relowner
        WHERE namespaces.nspname = ANY(${schemas}) AND owner.rolname = current_user
      ) AS "ownedObjectCount",
      EXISTS (
        SELECT 1
        FROM pg_database databases
        INNER JOIN pg_roles owner ON owner.oid = databases.datdba
        WHERE databases.datname = current_database() AND owner.rolname = current_user
      ) AS "ownsDatabase"
  `
  const actualSchemaPrivileges = schemaRows
    .map(({ schemaName, privilege }) => `${schemaName}:${privilege}`)
    .sort()
  const tablePrivileges = tableRows
    .map(({ schemaName, tableName, privilege }) =>
      `${schemaName}.${tableName}:${privilege}`)
    .sort()
  const sequencePrivileges = sequenceRows
    .map(({ schemaName, sequenceName, privilege }) =>
      `${schemaName}.${sequenceName}:${privilege}`)
    .sort()
  const columnPrivileges = columnRows
    .map(({ schemaName, tableName, columnName, privilege }) =>
      `${schemaName}.${tableName}.${columnName}:${privilege}`)
    .sort()
  const issues = [
    ...(!role ? ['Current PostgreSQL role was not found'] : []),
    ...(role?.roleName !== expectedRoleName
      ? [`Current role ${role?.roleName ?? '<missing>'} is not ${expectedRoleName}`]
      : []),
    ...(role && (
      role.superuser || role.inherit || role.createRole || role.createDatabase ||
      !role.canLogin || role.replication || role.bypassRls !== contract.bypassRls
    ) ? [`PostgreSQL role attributes exceed the ${contract.key} contract`] : []),
    ...((boundary?.memberOfCount ?? 0) !== 0
      ? ['PostgreSQL role must not be a member of another role']
      : []),
    ...((boundary?.ownedObjectCount ?? 0) !== 0
      ? ['PostgreSQL role must not own objects in managed schemas']
      : []),
    ...(boundary?.ownsDatabase ? ['PostgreSQL role must not own the database'] : []),
    ...compareExact(
      'schema privileges',
      actualSchemaPrivileges,
      expectedSchemaPrivileges(contract),
    ),
    ...compareExact(
      'table privileges',
      tablePrivileges,
      expectedObjectPrivileges(contract.tablePrivileges),
    ),
    ...compareExact(
      'column privileges',
      columnPrivileges,
      expectedColumnPrivileges(contract),
    ),
    ...compareExact(
      'sequence privileges',
      sequencePrivileges,
      expectedObjectPrivileges(contract.sequencePrivileges),
    ),
  ]
  return {
    contractKey: contract.key,
    role: role ?? null,
    schemaPrivileges: actualSchemaPrivileges,
    tablePrivileges,
    columnPrivileges,
    sequencePrivileges,
    issues,
  }
}

export async function assertCurrentPostgresRole(
  client: Sql,
  contract: PostgresRoleContract,
  expectedRoleName: string,
): Promise<PostgresRoleVerification> {
  const verification = await verifyCurrentPostgresRole(client, contract, expectedRoleName)
  if (verification.issues.length > 0) {
    throw new Error(
      `${contract.key} PostgreSQL role verification failed:\n${verification.issues.join('\n')}`,
    )
  }
  return verification
}
