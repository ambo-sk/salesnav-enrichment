/**
 * Sokin's ideal customer profile — the fallback every job is scored against.
 *
 * Precedence: a job's own `icp` (the extension's Settings field) wins, then the
 * DEFAULT_ICP var, then this. It lives in a source file rather than in
 * wrangler.jsonc because it is prose that gets edited often and reviewed in
 * diffs — a multi-line string escaped into JSON is neither.
 *
 * This file answers WHO to target and WHY. The scoring mechanics (0-100, tiers,
 * the JSON shape) live in openrouter.ts and are deliberately not repeated here.
 *
 * Cost note: this text ships on every scoring call — ~1.1k tokens x one call
 * per contact. Add disqualifiers and signals freely; avoid restating the
 * product pitch, which does not change a verdict.
 */

/**
 * Normalize an ICP supplied with a job.
 *
 * Deliberately NOT the same helper the short label fields use: that one caps at
 * 500 characters, which would silently decapitate a real target definition and
 * score the entire run against whatever fragment survived — a failure that
 * looks like nothing at all in the output. Bounded generously instead, since
 * this text ships on every scoring call and an accidental paste of a whole
 * sales handbook is a cost problem worth truncating.
 */
export function icpText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 20000) : '';
}

export const SOKIN_ICP = `## WHAT WE SELL

Sokin (sokin.com) is a cross-border payments and multi-currency treasury platform. We let a
business "trade like a local" in every market it operates in.

Capabilities, and the pain each one removes:
- 26 multi-currency accounts with local or international bank details; payments across 70+
  currencies to 170+ countries at wholesale rates. Local payment rails in the USA, Canada,
  Europe, UK and Australia — not SWIFT-only. Zero FX markup, no fees on incoming payments.
  (Removes: FX spread bleeding margin, needing a bank account per market, correspondent fees.)
- Free instant Sokin-to-Sokin transfers, 24/7, versus a bank's Mon-Fri 4pm cut-off and 3-5 day
  settlement. (Removes: weekend/cut-off dead time, payout delays to suppliers and sellers.)
- Boost Accounts: up to 3.74% AER on EUR, GBP and USD balances. (Turns idle treasury cash from
  a cost centre into a revenue line — matters most to anyone sitting on float or fresh funding.)
- Financial APIs for onboarding, FX payouts and e-commerce, embedded into the client's own
  product; native QuickBooks, Xero, Sage and Oracle NetSuite integrations; batch and mass
  payouts across currencies in one flow; configurable approval workflows.
  (Removes: manual AP runs, spreadsheet reconciliation, slow book closes, building payments
  infrastructure in-house.)
- Multi-currency checkout with like-for-like settlement (EUR/USD/GBP/CAD) and payment links;
  ~26% average saving on processing fees versus traditional providers.
- Credibility: $8BN+ remittance volume processed last year, backed by Morgan Stanley, Sunday
  Times Top 50 fastest-growing tech companies, segregated client funds with regulated banking
  partners and a full licensing suite.
- Reference customers: SAP (embedded infrastructure), Manchester United (FX and AP/AR),
  Excel London (400+ events, 4M visitors), Esenda (EdTech school-fee collection).

## THE TWO BUYING MOTIONS

Decide which one a contact belongs to; it changes who is actually the buyer.

MOTION A — Treasury and payments. The company itself moves money across borders: paying
overseas suppliers, staff, contractors, sellers or partners, or collecting from international
customers. Buyer sits in finance. This is the Manchester United / Excel London / Esenda shape.

MOTION B — Embedded infrastructure. The company is a platform, marketplace, SaaS or ERP whose
OWN customers need payouts, FX or onboarding, and who would rather integrate than build. Buyer
is a product or engineering leader, often alongside finance. This is the SAP shape. A contact
in Motion B can be a strong fit even with modest own-company cross-border spend, because the
volume arrives through their platform.

Begin the rationale with "Motion A — ", "Motion B — " or "No motion — " so the sheet can be
filtered by play. A contact can qualify under both; lead with the stronger one.

## WHO IS A GREAT FIT

Company:
- Genuinely multi-currency: multiple countries, entities, subsidiaries or markets. Cross-border
  supplier payments, international payroll or contractors, overseas customers, or marketplace
  payouts. This is the single strongest predictor — weight it above everything else.
- 50-5000 employees is the sweet spot. Below ~50 only if cross-border volume is clearly high
  (e-commerce, marketplaces, agencies with global contractors). Above 5000 still fits, but
  expect a longer cycle and an incumbent to displace.
- Sectors with proven traction: sports and entertainment, events and venues, education and
  EdTech, e-commerce and marketplaces, travel and hospitality, logistics and freight,
  staffing and recruitment agencies, professional services with global delivery, media and
  production, manufacturing and distribution with overseas suppliers, SaaS and platforms
  selling internationally.
- Signals of active pain: recent international expansion or a new market/entity, fresh
  funding (idle balances → Boost), an ERP or accounting migration, hiring in treasury /
  finance ops / AP / AR, high transaction volume, or visible frustration with banks.

Person — Motion A: CFO, Finance Director, VP/Head of Finance, Financial Controller, Treasurer,
Head of Treasury, Head of Payments, Head of AP or AR, Finance Operations lead, and in smaller
companies the COO or founder who still owns finance.

Person — Motion B: CTO, VP Engineering, Chief Product Officer, Head of Product, Head of
Payments, Head of Platform, Head of Partnerships or Head of Fintech at a platform business.

## HOW TO WEIGH IT

Roughly, in descending order of importance:
1. Does the COMPANY have real cross-border money movement (or platform payout volume)? If no,
   the ceiling is Tier C regardless of how senior the person is.
2. Can this PERSON own, champion or materially influence a payments or treasury decision?
3. Is there a concrete, dated trigger — expansion, funding, ERP change, finance hiring, an
   explicit complaint about banking or FX?
4. Does the company match a sector where we already have a reference to lean on?
5. Is the person visible and engaged on LinkedIn (gives us a warm way in)? This is a tiebreaker,
   never a substitute for 1-3. A silent CFO at a perfect-fit company still outranks a prolific
   poster at a domestic one.

Seniority without company fit is a weak lead. Company fit without seniority is a routable lead —
score it mid-range and let the buying_role field say who to go around them to.

## DISQUALIFY OR SCORE LOW

- Direct competitors and near-substitutes: Wise, Revolut, Airwallex, Payoneer, OFX, Ebury,
  Corpay/Cambridge, WorldFirst, Convera, Currencies Direct, Moneycorp, Equals Money, Alpha
  Group, Banking Circle, Nium, Thunes, Rapyd, Modulr, ClearBank, and FX brokers, money
  remitters or PSPs generally. Not_fit. (Exception: flag as a possible PARTNER in
  positive_signals if the fit is clearly Motion B, but keep the score low.)
- Banks and traditional financial institutions. Not_fit.
- Consultants, advisors, agencies-of-one, freelancers, coaches, fractional CFOs, VC/PE
  investors, recruiters and headhunters — no operational payment volume of their own.
  (An agency with genuinely global contractor payroll is the exception; say so explicitly.)
- Students, interns, job seekers, and anyone flagged open-to-work — score down hard, they will
  not be there for the cycle.
- Purely domestic, single-currency businesses with no international suppliers or customers.
- High-risk verticals a licensed provider generally cannot onboard: crypto and digital-asset
  trading, gambling and betting, adult, arms and defence exports, unlicensed MSBs, shell or
  holding entities with no visible operations.
- Anyone below manager level with no path to the budget — end_user at best.
- Someone who started their current role under ~3 months ago: still a fit, but say so in risks
  and drop confidence, since they will not own the budget yet.

## USING THE ACTIVITY WINDOW

The dossier carries 6 months of the person's posts and comments. Mine it for:
- Explicit pain: FX costs, spreads, hedging, bank delays, SWIFT, failed or delayed payments,
  reconciliation, month-end close, idle cash, interest rates, working capital.
- Expansion: new market, new office, new entity, international hires, "we're now live in X".
- Change events: funding round, ERP or accounting migration, new finance leadership,
  acquisition, a systems or process overhaul.
- Motion B tells: embedded finance, payouts, marketplace infrastructure, API integrations,
  "we built X in-house".
Absence of activity is NOT a negative signal about fit — most finance leaders post rarely. It
only lowers what we can personalize with, so it should reduce confidence and change the hook,
not the fit_score.

## THE HOOK

personalized_hook must be usable verbatim as a first line by an SDR. Anchor it to one concrete
thing in the dossier — a specific post, a role change, a named market they just entered, a
stated frustration — and connect it to ONE Sokin capability, not the whole product. Name the
relevant proof point only when the sector actually matches (Manchester United for sports,
Excel London for events and venues, Esenda for education, SAP for embedded infrastructure).
If the dossier contains nothing concrete, return an empty string. A generic opener is worse
than none — it tells the rep this contact needs manual research first.`;
