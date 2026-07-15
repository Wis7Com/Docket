export const BUILTIN_WORKFLOWS: { id: string; title: string; prompt_md: string }[] = [
    {
        id: "builtin-cp-checklist",
        title: "Generate CP Checklist",
        prompt_md:
            "## Generate Conditions Precedent Checklist\n\n" +
            "Review the uploaded credit agreement or financing document and generate a comprehensive " +
            "Conditions Precedent (CP) checklist.\n\n" +
            "You MUST use the generate_docx tool to produce the checklist as a downloadable Word document. " +
            "You MUST pass landscape: true to the generate_docx tool — the document must be in landscape orientation. " +
            "Do not display the checklist inline — generate the .docx file and provide the download link.\n\n" +
            "Structure the document as follows:\n" +
            "- For each category of conditions (e.g. Corporate, Financial, Legal, Security), add a section with a heading\n" +
            "- Under each category heading, include a table with exactly these four columns in this order:\n" +
            "  1. Index — sequential number within the category (1, 2, 3…)\n" +
            "  2. Clause Number — the clause or schedule reference from the agreement\n" +
            "  3. Clause — a concise description of the condition precedent\n" +
            "  4. Status — leave blank (empty string) for the user to fill in\n\n" +
            "Use the table field in the section object (not content) for each category's rows.\n\n" +
            "Before finalizing, double-check that every table is formatted correctly: each table must have exactly the four columns above in the same order, headers must match exactly (Index, Clause Number, Clause, Status), every row must have the same number of cells as the headers, the Index column must be sequential starting from 1 within each category, and no cells should contain stray markdown, newlines, or placeholder text (use an empty string for Status).",
    },
    {
        id: "builtin-issue-comparison",
        title: "Issue-by-Issue Comparison",
        prompt_md:
            "## Issue-by-Issue Comparison\n\n" +
            "Compare two or more selected documents, or two sides' briefs, issue-by-issue. If it is unclear which documents or sides the user wants compared, ask once before proceeding.\n\n" +
            "Use this retrieval sequence:\n" +
            "1. Identify the comparison documents or sides from AVAILABLE DOCUMENTS or with list_documents.\n" +
            "2. Discover the issue list with one or two broad search_project_documents calls using doc_roles:['brief'] unless the user explicitly includes evidence, or by skimming opening sections with read_index_chunk.\n" +
            "3. For every issue, run the same search_project_documents query once per document or side using doc_ids scoping.\n" +
            "4. Verify every quotation and page reference with read_index_chunk before citing it.\n" +
            "5. Produce a table whose rows are issues and whose columns are the compared documents or sides. Each cell must give the document's position or key point; say when a document is silent on an issue rather than inventing a position. Attach a [N] marker to every supported claim in every table cell and include a matching entry for every marker in the final <CITATIONS> block. Place each marker at the end of the relevant cell text; plain-text document names or page references are not verified and do not count as citations.\n\n" +
            "Return an inline Markdown table by default. If the user asks for a file, use generate_docx with landscape: true.",
    },
    {
        id: "builtin-brief-sequence-diff",
        title: "New Arguments Across Brief Sequence",
        prompt_md:
            "## New Arguments Across Brief Sequence\n\n" +
            "Identify which arguments in a later brief are new, elaborated, or repeated relative to the same party's earlier briefs. Use AVAILABLE DOCUMENTS metadata or list_documents to identify the target brief, its party_side, and its brief_sequence.\n\n" +
            "Follow this sequence:\n" +
            "1. Call summarize_document on the target (latest) brief to obtain a citation-backed inventory of its claims. Do not substitute a generic search for this whole-document pass.\n" +
            "2. Identify briefs with doc_role='brief', the same party_side, and a lower brief_sequence. For every claim from Step 1, call search_project_documents with doc_ids scoped to those earlier briefs and the same claim point.\n" +
            "3. Classify each claim as NEW only when it is substantively absent from the earlier briefs, ELABORATED when an earlier claim gains a new ground, authority, or legal theory, or REPEATED when only its wording changes. A wording change alone is never NEW. Never assert novelty without evidence; when the earlier record cannot be verified, flag the classification as unverified instead of guessing.\n" +
            "4. When the user requests opposing-party context, search briefs from the opposing party_side for its response to each claim.\n" +
            "5. Return a table with one row per claim and these columns: Latest brief + citation | Earlier brief status + citation | Classification. Every supported statement in every cell must carry a [N] marker backed by a matching entry in the final <CITATIONS> block. Plain-text document names or page references do not count as citations.\n\n" +
            "Return the table inline unless the user explicitly requests a file.",
    },
    {
        id: "builtin-credit-summary",
        title: "Credit Agreement Summary",
        prompt_md:
            "## Credit Agreement Summary\n\n" +
            "Review the uploaded credit agreement and produce a comprehensive legal summary covering the following topics. " +
            "For each section, identify the key provisions, quote the relevant clause or schedule references, and flag any unusual, onerous, or non-market terms.\n\n" +
            "1. **Lenders** — All lenders or members of the lender syndicate, including their full legal name and role (e.g. mandated lead arranger, original lender, agent bank)\n" +
            "2. **Borrowers** — All borrowers, including their full legal name and jurisdiction of incorporation\n" +
            "3. **Guarantors** — All guarantors, including their full legal name and the scope of their guarantee obligation\n" +
            "4. **Other Parties** — Any other material parties (e.g. facility agent, security agent, hedge counterparties, issuing bank) and their roles\n" +
            "5. **Date of Agreement** — Date of the credit agreement\n" +
            "6. **Facilities** — Each facility available (e.g. Revolving Credit Facility, Term Loan A, Term Loan B, Term Loan C), the facility type, tranche name, and any key structural features\n" +
            "7. **Amount** — Total committed amount across all facilities, the currency, and breakdown by tranche if applicable\n" +
            "8. **Purpose** — Stated purpose for which borrowings may be used and any restrictions on use of proceeds\n" +
            "9. **Interest** — Applicable reference rate (e.g. SOFR, EURIBOR, base rate), the margin, any margin ratchet mechanism, and how interest periods are structured\n" +
            "10. **Commitment Fee** — Commitment or utilisation fees, the applicable rate, how they are calculated, and the basis (e.g. undrawn commitment, average utilisation)\n" +
            "11. **Repayment Schedule** — Repayment profile for each facility, whether by scheduled instalments or bullet repayment, and the repayment dates and amounts\n" +
            "12. **Maturity** — Final maturity date for each facility\n" +
            "13. **Security** — Each class of security granted or required (e.g. share pledges, fixed and floating charges, real estate mortgages, account pledges) and the assets or entities over which security is taken\n" +
            "14. **Guarantees** — Guarantee obligations, the guarantors, the scope of the guarantee, and any limitations (e.g. up-stream guarantee limitations, guarantor coverage test)\n" +
            "15. **Financial Covenants** — Each financial covenant, the metric (e.g. leverage ratio, interest cover, cashflow cover), the applicable test, testing frequency, and any equity cure rights\n" +
            "16. **Events of Default** — Each event of default, noting any grace periods, materiality thresholds, or cross-default provisions\n" +
            "17. **Assignment** — Restrictions or permissions on assignment or transfer (e.g. white/blacklists, borrower consent for lender transfers; restrictions on borrower assignment)\n" +
            "18. **Change of Control** — What constitutes a change of control, what obligations it triggers (e.g. mandatory prepayment, cancellation, lender consent), and any cure period\n" +
            "19. **Prepayment Fee** — Any prepayment fees, make-whole premiums, or soft-call protections, the applicable fee, the period during which it applies, and any exceptions (e.g. prepayment from insurance proceeds or asset disposals)\n" +
            "20. **Governing Law** — Governing law of the agreement\n" +
            "21. **Dispute Resolution** — Whether disputes go to litigation or arbitration, the chosen forum or seat, and any submission to jurisdiction provisions\n\n" +
            "Deliver the summary inline in your chat response — do NOT call generate_docx. Only produce a downloadable Word document if the user explicitly asks for one.",
    },
    {
        id: "builtin-sha-summary",
        title: "Shareholder Agreement Summary",
        prompt_md:
            "## Shareholder Agreement Summary\n\n" +
            "Review the uploaded shareholder agreement and produce a comprehensive legal summary covering the following topics. " +
            "For each section, identify the key provisions, quote the relevant clause references, and flag any unusual, onerous, or market-standard deviations.\n\n" +
            "1. **Parties & Shareholdings** — Full legal names, roles, share classes held, and percentage interests (on a fully diluted basis if stated)\n" +
            "2. **Share Classes & Rights** — For each class: voting rights, dividend rights, liquidation preference, conversion or redemption features\n" +
            "3. **Board Composition & Governance** — Board size, director appointment rights (and the shareholding thresholds required to maintain them), quorum, and casting vote\n" +
            "4. **Reserved Matters** — Decisions requiring a special majority, unanimity, or a specific shareholder's consent; note the threshold and whose consent is required for each\n" +
            "5. **Pre-emption on New Shares** — Who holds pre-emption rights, procedure, timeline, and any carve-outs (e.g. employee option schemes)\n" +
            "6. **Transfer Restrictions** — Lock-up periods, prohibited transfers, permitted transfers (e.g. to affiliates), and any board or shareholder approval requirements\n" +
            "7. **Right of First Refusal / Pre-emption on Transfer** — Trigger, procedure, pricing mechanics, and any exceptions\n" +
            "8. **Drag-Along Rights** — Who holds the right, threshold to trigger, conditions (e.g. minimum price, independent valuation), and minority protections\n" +
            "9. **Tag-Along Rights** — Who holds the right, triggering threshold, exercise procedure, and price terms\n" +
            "10. **Anti-Dilution Protections** — Type (full ratchet, weighted average), trigger events, calculation mechanics, and exceptions\n" +
            "11. **Dividend Policy** — Any obligation or target to pay dividends, preferential dividend rights, and restrictions on distributions\n" +
            "12. **Exit & Liquidity** — Agreed exit routes (trade sale, IPO, drag sale), timelines, and liquidation preferences on exit\n" +
            "13. **Deadlock** — Deadlock definition, escalation and resolution mechanisms (e.g. Russian roulette, put/call options), and consequences if unresolved\n" +
            "14. **Non-Compete & Non-Solicitation** — Who is bound, scope of activities and geography, duration, and carve-outs\n" +
            "15. **Governing Law & Dispute Resolution** — Applicable law, forum, arbitration or litigation, and any mandatory escalation steps\n\n" +
            "Generate the summary as a downloadable Word document.",
    },
];
