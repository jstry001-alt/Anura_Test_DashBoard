# Sales Force Dashboard – V2 (with access control)

A web dashboard for management to follow sales-force activity in SAP Business One:
sales, orders, approvals, deliveries, invoices, returns and customer balances.
It reads everything through the **Sales API** (`Sales_API_Endpoint_Reference-2.docx`);
it never writes to SAP.

## Run it

1. Install Node.js 18 or newer (no other packages are needed).
2. Check the settings in `.env` (API address, API key, port, logins).
3. Double-click `start.bat`, or run `node server.js`.
4. Open `http://localhost:8080` (or `http://<server-ip>:8080` from other PCs) and sign in.

On the very first start V2 creates `data\users.json` with one administrator from `DASH_USERS` in `.env`
(user name and password as written there, e.g. `admin:ChangeMe2026`). That password must be changed at the first sign-in. After that, `DASH_USERS` is ignored and
users are managed in the dashboard. V1 (`..\SalesForceDashboard`) is unchanged; both use port 8080, so run one at a time
or change `PORT` in one of them.

To keep it running on a server, install it as a Windows service (for example with NSSM) or run it under PM2.

## Access control (new in V2)

Open **Administration → Users & permissions** (administrators only).

| Setting | What it does |
|---|---|
| Role | Starting point that ticks the usual pages: Administrator, Management, Sales manager, Finance, Sales rep, Viewer. The ticks can then be changed per user. |
| Pages | Exactly which of the 15 pages the user sees in the menu and can call on the server. |
| Download tables to Excel | Shows the Excel (CSV) button on tables. |
| Refresh data from SAP | Allows the Refresh button (re-reads SAP; heavy on long ranges). |
| Data access: reps | "All reps", or only the ticked sales reps. A sales rep normally gets just their own code. |
| Data access: companies | Anura Trading Lanka (4) and/or Anura Lubricants (5); none ticked = both. |
| Administrator | All pages, all data, and the right to manage users. |
| Active / Must change password | Disable an account without deleting it; force a new password at next sign-in. |

How it is enforced:
- Every server call is checked against the user's pages; the menu only reflects that. Data limits are applied on the
  server, so a limited user never receives other reps' or the other company's rows, totals or documents (opening
  another rep's order by number is refused).
- "Not issued" lines carry no rep or company, so limited users cannot open that page. Sales orders and return requests
  carry no company in the Sales API, so for those only the rep limit applies.
- Passwords are stored as scrypt hashes; at least 8 characters with letters and numbers, not containing the user name.
- 5 wrong passwords for a user from one address lock that sign-in for 15 minutes.
- Sessions last `SESSION_HOURS` (12). Disabling a user, resetting their password or deleting them signs them out at once.
- Changes, sign-ins, failed sign-ins and refused access are listed under **Activity log** and kept in `data\audit.log`.
- At least one active administrator always remains; administrators cannot remove their own rights.

### Moving users to a new version

1. In the old version: **Users & permissions → Export users** (keep "Include passwords" ticked so people keep their
   passwords). This downloads `sfd-users-<version>-<date>.json`.
2. Start the new version, sign in as its first administrator, open **Users & permissions → Import users**, choose the file
   and pick **Merge** (add/update, keep others) or **Replace** (user list becomes exactly the file).
3. **Check file** shows what will be added, updated or removed, with notes; nothing is saved until **Import now**.

The file records which pages existed when it was exported. Pages that are new in the later version are given to each user
whose role includes them by default (for example Item stock for sales reps); pages that no longer exist are dropped with a
warning. The administrator doing the import always stays an active administrator and keeps their own password. Without
passwords in the file, new accounts are created disabled until an administrator resets their password. Exports and imports
are listed in the Activity log. The file contains password hashes: store it like any other credential file.

Back up the `data` folder: it holds the users. If every administrator password is lost, stop the server, rename
`data\users.json`, and start again: a new first administrator is created from `DASH_USERS`.

## Pages

| Page | What it answers |
|---|---|
| Overview | Sales, orders, approvals, fulfilment, collection, returns; daily charts; top reps and customers; a "needs attention" list |
| Sales orders | Every order in the date range with status, fulfilment, deliveries, invoices, payment; tabs for each status, not-fully-issued, qty changed, unpaid |
| Track a document | Look up a sales order, quotation, return request, part number, item stock or customer; shows the quotation → order → approval → delivery → invoice → payment chain |
| Item stock | Search by item code, name or part number (optionally in stock only); status (in stock / all committed / on order only / out of stock), stock, committed, available and on order per warehouse with warehouse name and company, and every batch. Item links elsewhere open the same view |
| Approvals | Orders waiting for approval (all dates) with ageing, by rep; rejected orders in range |
| Not issued | Order lines not fully picked, with reasons and pick plan / pick list status; lines ready to close |
| Invoices | Invoices with company, payment status, returns and delivery info; click for lines |
| Returns | Return requests and their goods-return / credit-note progress; return credit notes |
| Quotations | Quotation-to-order conversion and line outcomes |
| Sales reps | Scorecard per rep: orders, pending, fulfilment, days to invoice, invoiced, collected, returns |
| Customers | Customers active in range; click for grade, aged outstanding statement, open items and bank details |

Every number, row and document number is clickable through to the detail. Every table can
be searched, sorted and downloaded as CSV for Excel. Filters at the top (date range,
rep, customer) apply to every page. A link with `?from=YYYY-MM-DD&to=YYYY-MM-DD`
(for example `#/orders?from=2026-09-01&to=2026-09-30`) opens that range directly.
`?range=all` (or `last7`, `mtd`, `last30`, `lastmonth`, `last90`, `ytd`) opens a preset.

**All dates** reads from `ALL_FROM` (2025-01-01) to today. Long ranges are drawn by week (over 62 days)
or by month (over 210 days), and the SAP analytics pages skip the previous-period comparison. The first
All-dates load took about 12 minutes on 2026-10-09 (Sales API invoices are the slow part); after that it is read from
the cache. Days older than a month are re-read once a day.

## SAP analytics (Service Layer)

Four extra pages read SAP Business One directly through the Service Layer (`SL_*` settings in `.env`).
They only read data; the only call that is not a GET is the Login.

| Page | What it answers |
|---|---|
| Sales & margin | Net sales after returns and discount credit notes, gross profit and margin, each compared with the previous period of the same length; by company, rep and customer |
| Products & brands | Sales, margin, share and growth by brand, category, item group, item and warehouse; days of stock cover per item; fast sellers running low |
| Item grades | ABC grade of every item by net sales in the range, and the A/B/C split per item category (A = first 80% of sales value, B = next 15%, C = rest) with stock and estimated stock value; stocked items with no sales; item / brand / sales group / part type sales split by customer grade (from Credit_Check) with payment term and period discount |
| Collections & cheques | Incoming payments by day and method, by rep (through the invoices each payment settled), by customer and company; every cheque with its due date |
| Credit control | Open invoices aged by due date, overdue and 90+ days by rep, credit limit use and over-limit customers, customers without a limit, credit balances, customers on hold |

How it reads SAP: this Service Layer does not support `$apply` (server-side totals), so `sl.js` pages through
documents one day at a time (`$crossjoin` of invoice / credit-note lines with the item master, 5,000 rows a page),
caches each day in `cache\sl\` like the Sales API data, and totals them on the server. Customer, rep, item-group,
stock and open-invoice lists are cached for 30 minutes to 6 hours. One week plus the week before takes about a
minute the first time.

What this company keeps outside standard SAP (checked against a copy of the test company database, data to 2 Oct 2026):
- Credit limits and grades are per company in the **Credit_Check** object (`@C_CHECK_H/L`), not on the business partner
  (the BP credit limit is mostly 0). Credit control uses these: limit, grade and use per company (ATL = 4, AL = 5).
- Grades A–Z (`CUSTOMER_GRADES`) set the payment term and the period-discount % paid within 15 days.
- Brand names come from `IM_BrandCode`; items also carry a sales group (JAPAN-01, INDIAN, two/three wheel, lubricant…)
  and a part classification, both available as product views.
- Cheques carry `U_ChqType` PDC / CDC. A returned or stopped cheque is recorded by cancelling the receipt with
  `U_CancelType` = Return_Cheque / Stopped_Cheque (reason in `U_CancelReason`); Collections lists them.
- Invoice route (`U_Route`) and commission fields exist but are empty, so they are not used.

Points to know:
- Most customers have no sales employee on the business partner, so collections and receivables are credited to
  the rep on the invoices, not the customer's rep.
- Net sales use item lines; opening-balance service invoices are excluded. Discount credit notes
  (`U_CreditNotType` PeriodDiscount / ProductDiscount) reduce net sales and gross profit, but are not split by item or brand.
- Approval requests in this company are all purchasing documents, so they are not shown; sales approvals are on the Approvals page.

## How the data is fetched

The API is slow for long ranges (one busy day of orders is about 2.5 MB and 7–18 s; a whole
month in one call times out), so `server.js`:

- splits every date range into single days and asks the API for up to 4 days at a time;
- keeps each day in `cache\` and reuses it: today for 5 minutes, the last 3 days for
  30 minutes, the last month for 3 hours, older days for 1 day. **Refresh** fetches again;
- refreshes the last 7 days in the background every 10 minutes, so the default views open quickly;
- sends the browser a trimmed copy of each record; the API key never leaves the server;
- limits one request to 800 days (`MAX_RANGE_DAYS`). The first load of a full month takes
  roughly 1–2 minutes; after that it is instant.

The API's certificate is self-signed, so certificate checking is turned off for calls to `API_BASE` only.

## Notes on the data

- "Invoiced sales" uses the `/api/invoices` endpoint, which returns SFA invoices and the
  ATL-RTN service invoices (UserSign 88). The Invoices page has a tab for each.
- The order status names come from SAP (`Pending Approvel` is shown as "Pending approval").
- The Not issued and Ready to close lists have no rep and come from SAP as-is, so the date
  and rep filters do not apply to them.
- Quotations without a sales order have no customer or rep in the API, so they are hidden
  while a rep or customer filter is set.
- The outstanding statement uses the company chosen in the customer view (default `DEFAULT_BPL_ID`).
