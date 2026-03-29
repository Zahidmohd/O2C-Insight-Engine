/**
 * Validates the generated SQL for safety constraints.
 * Returning true if safe, throws Error if invalid or unsafe.
 */
function validateSql(sql) {
    if (!sql || typeof sql !== 'string') {
        throw new Error('Empty SQL string provided.');
    }

    // Strip SQL comments before validation to prevent bypass via -- or /* */
    let stripped = sql
        .replace(/--[^\n]*/g, '')       // single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, ''); // block comments

    const cleanSql = stripped.trim().toLowerCase();

    // Safety check: must be a SELECT statement
    if (!cleanSql.startsWith('select')) {
        throw new Error('Only SELECT statements are permitted.');
    }

    // Reject multi-statement SQL (semicolons mid-query)
    // Remove trailing semicolon first, then check for remaining ones
    const withoutTrailing = cleanSql.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
        throw new Error('Execution rejected: multi-statement SQL is not allowed.');
    }

    // Reject modifications and risky statements
    const blocklist = [
        'insert ', 'update ', 'delete ', 'drop ', 'truncate ',
        'alter ', 'create ', 'replace ', 'pragma ', 'grant ', 'revoke '
    ];

    for (const token of blocklist) {
        if (cleanSql.includes(token)) {
            throw new Error(`Execution rejected: SQL contains forbidden instruction '${token.trim()}'`);
        }
    }

    // Limit arbitrary function executions to prevent DoS or command injection if extensions load
    if (cleanSql.includes('sqlite_') || cleanSql.includes('load_extension')) {
        throw new Error('SQLite administrative and extension functions are restricted.');
    }

    // Reject computationally dangerous nested Subqueries inside execution JOINS preserving explicit indexing flows
    if (/\bJOIN\b[\s\S]*?\(\s*SELECT/i.test(stripped)) {
        throw new Error('Execution rejected: Subqueries inside JOIN conditions break multi-hop query graphs. Please use explicit direct table joins.');
    }

    return true;
}

module.exports = {
    validateSql
};
