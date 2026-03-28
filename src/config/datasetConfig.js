/**
 * Dataset configuration for the SAP O2C domain.
 * Single source of truth for domain keywords, entity types, and relationship labels.
 * Consumed by: isDomainQuery(), buildExplanation(), queryClassifier.
 */

const domainKeywords = [
    'order', 'sales', 'delivery', 'bill', 'invoice',
    'journal', 'payment', 'customer', 'product', 'plant',
    'document', 'item', 'amount', 'clearing', 'flow',
    'company', 'fiscal', 'accounting', 'partner',
    'trace', 'material', 'address', 'status', 'cancelled',
    'billed', 'delivered', 'posted', 'cleared', 'entry',
    'shipping', 'quantity', 'currency', 'net', 'total',
    'o2c', 'sap', 'transaction', 'record', 'data'
];

const entities = [
    'sales order', 'delivery', 'billing', 'invoice',
    'journal', 'journal entry', 'payment', 'customer',
    'product', 'plant', 'material', 'business partner'
];

const relationships = [
    'FULFILLED_BY', 'BILLED_AS', 'BILLED_DIRECTLY',
    'POSTED_AS', 'CLEARED_BY', 'ORDERED', 'BILLED_TO',
    'CONTAINS_PRODUCT', 'PRODUCED_AT', 'SHIPS_FROM', 'CANCELS'
];

module.exports = { domainKeywords, entities, relationships };
