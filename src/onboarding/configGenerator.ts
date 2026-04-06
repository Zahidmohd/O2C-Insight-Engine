/**
 * Generates a full dataset config from user-approved schema and relationships.
 * Output is compatible with existing datasetValidator + loader + queryService.
 *
 * generateConfig({ name, tables, relationships, dataDir }) -> config object
 */

// --- Domain Keyword Generation -----------------------------------------------

/**
 * Auto-generates domain keywords from table and column names.
 * Splits snake_case into individual words, deduplicates, lowercases.
 */
function generateDomainKeywords(tables: Array<{ name: string; columns: string[] }>): string[] {
    const wordSet = new Set<string>();

    for (const t of tables) {
        // Add full table name (both raw and space-separated)
        wordSet.add(t.name.toLowerCase());
        wordSet.add(t.name.replace(/_/g, ' ').toLowerCase());

        // Split table name into words
        for (const word of splitToWords(t.name)) {
            if (word.length >= 3) wordSet.add(word);
        }

        // Add full column names + split words
        for (const col of t.columns) {
            wordSet.add(col.toLowerCase());
            for (const word of splitToWords(col)) {
                if (word.length >= 3) wordSet.add(word);
            }
        }
    }

    return Array.from(wordSet).sort();
}

/**
 * Splits a camelCase or snake_case string into lowercase words.
 */
function splitToWords(str: string): string[] {
    return str
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase split
        .replace(/[_\-]+/g, ' ')                  // snake_case split
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 0);
}

// --- Entity Generation -------------------------------------------------------

/**
 * Generates entity types from table display names.
 */
function generateEntities(tables: Array<{ name: string; displayName?: string }>): string[] {
    return tables.map((t) => {
        const display = t.displayName || t.name.replace(/_/g, ' ');
        return display.toLowerCase();
    });
}

// --- Display Name Generation -------------------------------------------------

/**
 * Generates a human-readable display name from a dataset name.
 * "my_sales_data" -> "My Sales Data"
 */
function generateDisplayName(name: string): string {
    return name
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase());
}

// --- Main Config Generator ---------------------------------------------------

interface TableInput {
    name: string;
    displayName?: string;
    columns: string[];
    primaryKey?: string[];
}

interface RelationshipInput {
    from: string;
    to: string;
    label?: string;
    joinType?: string;
    description?: string;
}

interface GenerateConfigParams {
    name: string;
    tables: TableInput[];
    relationships?: RelationshipInput[];
    dataDir: string;
}

/**
 * Generates a complete config object compatible with the existing pipeline.
 */
function generateConfig({ name, tables, relationships, dataDir }: GenerateConfigParams): any {
    if (!name || typeof name !== 'string') {
        throw new Error('Dataset name is required.');
    }
    if (!tables || tables.length === 0) {
        throw new Error('At least one table is required.');
    }

    const configTables = tables.map((t) => ({
        name: t.name,
        displayName: t.displayName || generateDisplayName(t.name),
        directory: t.name,  // subdirectory matches table name
        columns: t.columns,
        primaryKey: t.primaryKey || [],
        transforms: {}      // no transforms for generic datasets
    }));

    const configRelationships = (relationships || []).map((r) => ({
        from: r.from,
        to: r.to,
        label: r.label || 'LINKS_TO',
        joinType: r.joinType || 'LEFT JOIN',
        description: r.description || `${r.from} -> ${r.to}`
    }));

    const domainKeywords = generateDomainKeywords(configTables);
    const entities = generateEntities(configTables);
    const relationshipLabels = configRelationships.map((r) => r.label);

    return {
        name: name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        displayName: generateDisplayName(name),
        description: `Auto-generated dataset from ${configTables.length} uploaded file(s).`,
        dataDir: dataDir,
        tables: configTables,
        relationships: configRelationships,
        domainKeywords,
        entities,
        relationshipLabels,
        rules: '',    // no domain-specific rules for generic datasets
        examples: ''  // no few-shot examples for generic datasets
    };
}

export {
    generateConfig,
    generateDomainKeywords,
    generateEntities
};
