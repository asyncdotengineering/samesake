// The real Micro Solutions / DCSL SD-WAN BOM (22 priced lines), extracted from the Cisco CCW
// "Price Estimate". `ciscoDiscountPct`, `ciscoExtendedNet`, and `ciscoBucket` are Cisco's own
// numbers — used here ONLY to validate that our catalog-free rules recover the same classification.
export type Bucket = "product" | "service" | "subscription";
export interface BomLine {
  partNumber: string;
  description: string;
  listPrice: number;
  qty: number;
  /** Cisco's per-line discount off list (ground truth, for validation). */
  ciscoDiscountPct: number;
  /** Cisco's extended net cost for the line (5-year term already applied). */
  ciscoExtendedNet: number;
  /** Cisco's own bucket, from the estimate's Total formulas (ground truth). */
  ciscoBucket: Bucket;
}

export const CISCO_BOM: BomLine[] = [
  { partNumber: "C8151-G2", description: "Cisco 8100 Series Secure Router, 8151-G2", listPrice: 2041.22, qty: 2, ciscoDiscountPct: 76, ciscoExtendedNet: 979.78, ciscoBucket: "product" },
  { partNumber: "CON-ROB-C8151G2A", description: "RMA UPGRADE 8X5XNBD Cisco Secure WAN 810", listPrice: 563.75, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 293.16, ciscoBucket: "service" },
  { partNumber: "C8151-G2-RM-19", description: "Rack mount kit - 19' Fixed for Cisco C8151-G2/C8161-G2", listPrice: 155.1, qty: 2, ciscoDiscountPct: 76, ciscoExtendedNet: 74.44, ciscoBucket: "product" },
  { partNumber: "R-OS-S-E", description: "Cisco OS Essentials - Small (Embedded, Perpetual)", listPrice: 500, qty: 2, ciscoDiscountPct: 76, ciscoExtendedNet: 240, ciscoBucket: "product" },
  { partNumber: "C8151-G2", description: "Cisco 8100 Series Secure Router, 8151-G2", listPrice: 2041.22, qty: 2, ciscoDiscountPct: 76, ciscoExtendedNet: 979.78, ciscoBucket: "product" },
  { partNumber: "CON-ROB-C8151G2A", description: "RMA UPGRADE 8X5XNBD Cisco Secure WAN 810", listPrice: 563.75, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 293.16, ciscoBucket: "service" },
  { partNumber: "C8151-G2-RM-19", description: "Rack mount kit - 19' Fixed for Cisco C8151-G2/C8161-G2", listPrice: 155.1, qty: 2, ciscoDiscountPct: 76, ciscoExtendedNet: 74.44, ciscoBucket: "product" },
  { partNumber: "R-OS-S-E", description: "Cisco OS Essentials - Small (Embedded, Perpetual)", listPrice: 500, qty: 2, ciscoDiscountPct: 76, ciscoExtendedNet: 240, ciscoBucket: "product" },
  { partNumber: "LIC-CSWAN-S-A", description: "Cisco SD-WAN Advantage Lic - Small", listPrice: 56, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 1747.2, ciscoBucket: "subscription" },
  { partNumber: "LIC-SEC-S-M", description: "Cisco 8000 Small series Security Add-on (AMP)", listPrice: 3, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 93.6, ciscoBucket: "subscription" },
  { partNumber: "LIC-SEC-S-T", description: "Cisco 8000 Small series Security Add-on (Threat)", listPrice: 3, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 93.6, ciscoBucket: "subscription" },
  { partNumber: "LIC-SEC-S-C", description: "Cisco 8000 Small series Security Add-on (URL-F)", listPrice: 3, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 93.6, ciscoBucket: "subscription" },
  { partNumber: "LIC-CSWAN-HCLD", description: "Cisco Cloud Hosted", listPrice: 20, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 624, ciscoBucket: "subscription" },
  { partNumber: "LIC-CSWAN-S-A", description: "Cisco SD-WAN Advantage Lic - Small", listPrice: 56, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 1747.2, ciscoBucket: "subscription" },
  { partNumber: "LIC-SEC-S-M", description: "Cisco 8000 Small series Security Add-on (AMP)", listPrice: 3, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 93.6, ciscoBucket: "subscription" },
  { partNumber: "LIC-SEC-S-T", description: "Cisco 8000 Small series Security Add-on (Threat)", listPrice: 3, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 93.6, ciscoBucket: "subscription" },
  { partNumber: "LIC-SEC-S-C", description: "Cisco 8000 Small series Security Add-on (URL-F)", listPrice: 3, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 93.6, ciscoBucket: "subscription" },
  { partNumber: "LIC-CSWAN-HCLD", description: "Cisco Cloud Hosted", listPrice: 20, qty: 2, ciscoDiscountPct: 74, ciscoExtendedNet: 624, ciscoBucket: "subscription" },
  { partNumber: "C1121X-8P", description: "ISR 1100 8P Dual GE SFP WAN 8GB Router", listPrice: 1878, qty: 30, ciscoDiscountPct: 76, ciscoExtendedNet: 13521.6, ciscoBucket: "product" },
  { partNumber: "CON-SNT-C1121X8P", description: "SNTC-8X5XNBD ISR 1100 8P Dual GE SFP WAN 8GB Router", listPrice: 852.5, qty: 30, ciscoDiscountPct: 74, ciscoExtendedNet: 6649.5, ciscoBucket: "service" },
  { partNumber: "ACS-1100-RM2-19", description: "Cisco 1100 Series Router Rackmount  2 Wallmount Kit", listPrice: 121.7, qty: 30, ciscoDiscountPct: 76, ciscoExtendedNet: 876.3, ciscoBucket: "product" },
  { partNumber: "DNA-C-T0-5M-A-5Y", description: "Cisco DNA Advantage Cloud Lic 5Y - upto 5M (Aggr, 10M)", listPrice: 3375, qty: 30, ciscoDiscountPct: 74, ciscoExtendedNet: 26334, ciscoBucket: "subscription" },
];
