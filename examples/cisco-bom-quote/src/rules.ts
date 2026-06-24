// The whole "no inventory catalog needed" trick: Cisco's SKU prefixes are systematic, so a
// handful of regex rules classify every line into product / service / subscription. This is the
// same rule-pack idea as bom-quotation's prefix pricing — keyed on the part number instead of
// extracted specs.
export type Kind = "product" | "service" | "subscription";

export interface ClassRule {
  match: RegExp; // tested against the Cisco part number
  kind: Kind;
  why: string;
}

// Order matters: the first rule that matches wins.
export const CLASSIFY_RULES: ClassRule[] = [
  { match: /^CON-/, kind: "service", why: "CON- → Cisco support / RMA service contract" },
  { match: /^(LIC|DNA|TE|SVS|SSP|SUB)-/, kind: "subscription", why: "LIC/DNA/TE/… → term software subscription" },
  { match: /^R-OS-/, kind: "product", why: "R-OS- → embedded / perpetual OS license (one-time)" },
  { match: /^(C\d|ISR|ACS-|PWR-|CAB-|NIM-|SFP-|GLC-|NETWORK-|IOSXE)/, kind: "product", why: "hardware model / accessory / perpetual" },
];

export interface PricingPolicy {
  // Cisco's discount off list, per kind — used ONLY to validate the classification.
  ciscoDiscountPct: Record<Kind, number>;
  // Micro Solutions' resale margin on Cisco net, per kind — the value you actually add.
  margin: Record<Kind, number>;
}

export const POLICY: PricingPolicy = {
  ciscoDiscountPct: { product: 76, service: 74, subscription: 74 },
  margin: { product: 0.15, service: 0.2, subscription: 0.12 },
};
