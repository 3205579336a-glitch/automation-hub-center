export interface RfqHeader {
  documentType: string
  purchasingOrganization: string
  purchasingGroup: string
  quotationDeadline: string
  currency: string
  headerText: string
}

export interface RfqItem {
  id: number
  material: string
  description: string
  quantity: string
  unit: string
  plant: string
  deliveryDate: string
}

export interface Supplier {
  id: number
  number: string
  name: string
}
