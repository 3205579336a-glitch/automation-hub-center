export const SAP_TRANSACTIONS = {
  sapMenu: 'SMEN',
  createRfq: 'ME41'
} as const

export type SapTransactionCode = (typeof SAP_TRANSACTIONS)[keyof typeof SAP_TRANSACTIONS]
