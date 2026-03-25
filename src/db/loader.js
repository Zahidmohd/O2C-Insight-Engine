const fs = require('fs');
const path = require('path');
const db = require('./connection');
const initDB = require('./init');

const BATCH_SIZE = 100;
const DATA_DIR = path.resolve(__dirname, '../../sap-o2c-data');

const TABLES = [
  { name: 'plants', directory: 'plants', transforms: {} },
  { name: 'business_partners', directory: 'business_partners', transforms: {} },
  { name: 'products', directory: 'products', transforms: {} },
  { name: 'business_partner_addresses', directory: 'business_partner_addresses', transforms: {} },
  { name: 'customer_company_assignments', directory: 'customer_company_assignments', transforms: {} },
  { name: 'customer_sales_area_assignments', directory: 'customer_sales_area_assignments', transforms: {} },
  { name: 'product_descriptions', directory: 'product_descriptions', transforms: {} },
  { name: 'product_plants', directory: 'product_plants', transforms: {} },
  { name: 'product_storage_locations', directory: 'product_storage_locations', transforms: {} },
  { name: 'sales_order_headers', directory: 'sales_order_headers', transforms: {} },
  { 
    name: 'sales_order_items', 
    directory: 'sales_order_items', 
    transforms: {
      // ⚠️ CRITICAL: Pad to 6 digits to match delivery documents reference items
      salesOrderItem: (val) => (typeof val === 'string' && val ? val.padStart(6, '0') : val)
    } 
  },
  { name: 'sales_order_schedule_lines', directory: 'sales_order_schedule_lines', transforms: {} },
  { name: 'outbound_delivery_headers', directory: 'outbound_delivery_headers', transforms: {} },
  { name: 'outbound_delivery_items', directory: 'outbound_delivery_items', transforms: {} },
  { name: 'billing_document_headers', directory: 'billing_document_headers', transforms: {} },
  {
    name: 'billing_document_items',
    directory: 'billing_document_items',
    transforms: {
      // ⚠️ CRITICAL: Pad to 6 digits for clean joins
      referenceSdDocumentItem: (val) => (typeof val === 'string' && val ? val.padStart(6, '0') : val)
    }
  },
  { name: 'billing_document_cancellations', directory: 'billing_document_cancellations', transforms: {} },
  { name: 'journal_entry_items_accounts_receivable', directory: 'journal_entry_items_accounts_receivable', transforms: {} },
  { name: 'payments_accounts_receivable', directory: 'payments_accounts_receivable', transforms: {} }
];

async function loadTable(tableConfig) {
  const dirPath = path.join(DATA_DIR, tableConfig.directory);
  if (!fs.existsSync(dirPath)) {
    console.warn(`Directory not found for table ${tableConfig.name}: ${dirPath}`);
    return 0;
  }

  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
  let totalInserted = 0;

  console.log(`Starting load for table: ${tableConfig.name}`);
  await db.execAsync('BEGIN TRANSACTION');

  try {
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split('\n');

      let batch = [];
      let batchParams = [];

      for (const line of lines) {
        if (!line.trim()) continue;

        let record;
        try {
          record = JSON.parse(line);
        } catch (e) {
          console.error(`Failed to parse line in ${file}: ${e.message}`);
          continue;
        }

        // Apply transformations
        for (const [key, transformFn] of Object.entries(tableConfig.transforms)) {
          if (record[key] !== undefined) {
            record[key] = transformFn(record[key]);
          }
        }

        // Convert values to types accepted by better-sqlite3 (number, string, bigint, buffer, null)
        const keys = Object.keys(record);
        const values = keys.map(k => {
          const v = record[k];
          if (v === null || v === undefined) return null;
          if (typeof v === 'boolean') return v ? '1' : '0';
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        });

        const placeholders = keys.map(() => '?').join(', ');
        const sql = `INSERT OR IGNORE INTO ${tableConfig.name} (${keys.join(', ')}) VALUES (${placeholders})`;

        batch.push(sql);
        batchParams.push(values);

        // Execute batch if limit reached
        if (batch.length >= BATCH_SIZE) {
          await executeBatch(batch, batchParams);
          totalInserted += batch.length;
          batch = [];
          batchParams = [];
        }
      }

      // Execute remaining batch
      if (batch.length > 0) {
        await executeBatch(batch, batchParams);
        totalInserted += batch.length;
      }
    }

    await db.execAsync('COMMIT');
    console.log(`✅ Loaded ${totalInserted} rows into ${tableConfig.name}`);
    return totalInserted;
  } catch (err) {
    await db.execAsync('ROLLBACK');
    console.error(`❌ Failed to load ${tableConfig.name}: ${err.message}`);
    throw err;
  }
}

// Helper to execute multiple parameterised statements in a batch
async function executeBatch(queries, paramSets) {
  for (let i = 0; i < queries.length; i++) {
    await db.runAsync(queries[i], paramSets[i]);
  }
}

async function runValidationQueries() {
  console.log('\n--- Post-Load Validation ---');

  // Check padding
  const paddingCheck = await db.allAsync(`
    SELECT COUNT(*) as unpaddedCount 
    FROM billing_document_items 
    WHERE LENGTH(referenceSdDocumentItem) < 6
  `);
  if (paddingCheck[0].unpaddedCount === 0) {
    console.log(`✅ Billing padding test passed.`);
  } else {
    console.error(`❌ Billing padding test failed. Found ${paddingCheck[0].unpaddedCount} unpadded items.`);
  }

  // Check multi-hop join
  const joinCheck = await db.getAsync(`
    SELECT COUNT(*) AS o2c_rows
    FROM sales_order_headers soh
    JOIN outbound_delivery_items odi ON odi.referenceSdDocument = soh.salesOrder
    JOIN billing_document_items bdi ON bdi.referenceSdDocument = odi.deliveryDocument
        AND bdi.referenceSdDocumentItem = odi.deliveryDocumentItem
    JOIN billing_document_headers bdh ON bdh.billingDocument = bdi.billingDocument
    JOIN journal_entry_items_accounts_receivable je
        ON je.companyCode = bdh.companyCode
        AND je.fiscalYear = bdh.fiscalYear
        AND je.accountingDocument = bdh.accountingDocument
  `);
  console.log(`✅ Multi-hop join test returned ${joinCheck.o2c_rows} rows.`);
}

async function main() {
  await initDB();
  
  let totalRows = 0;
  for (const table of TABLES) {
    const inserted = await loadTable(table);
    totalRows += inserted;
  }

  console.log(`\n🎉 Data loading complete. Total rows inserted: ${totalRows}`);

  await runValidationQueries();

  db.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error("Critical error in main:", err);
    process.exit(1);
  });
}

module.exports = { loadTable };
