# Dormitory Management System

Admin and resident portals for a dormitory: resident accounts, rooms, payment monitoring, announcements,
reminders, visitor log and curfew monitoring. Runs with PHP and SQLite in XAMPP, or with Node.js for development.

## Run in XAMPP

1. Copy this folder to `C:\xampp\htdocs\shan`.
2. In XAMPP, start **Apache**.
3. Open `http://localhost/shan/` in Chrome.

Enable `pdo_sqlite` and `mbstring` in `C:\xampp\php\php.ini` if they are disabled, then restart Apache.
The existing database is `data/dormitory-v2.sqlite`; keep this file when updating the app. The database folder
is blocked from direct web access.

## First-time admin setup in XAMPP

From PowerShell, run:

```powershell
& 'C:\xampp\php\php.exe' 'C:\xampp\htdocs\shan\setup-admin.php' julyna --generate
```

This creates or resets the `julyna` admin's PHP login password and prints a one-time generated password.
Save it privately. Use it with the **Admin** tab at `http://localhost/shan/`. To use another admin username,
replace `julyna` with your chosen username. Do not share the password or expose the local app to the internet.

## Resident accounts

Public resident registration is disabled. Sign in as an admin, open **Resident Management**, and add each resident
using their **Student ID** and a password (at least 12 characters). Residents sign in using only their Student ID
and password. To give an existing resident access after moving to PHP, edit their record as admin and set a new password.
Only admins can create resident accounts or reset their passwords. Use **More → Admin Accounts** to create additional
administrator logins; all administrators have full access to the system.

Admins can export resident and payment records as CSV files that open in Excel.

### Just want to look around?

For the optional Node.js development version:

```sh
npm run seed-demo
```

Creates sample rooms, residents, payments and notices. Admin: `admin` / `admin-demo-12345`,
residents: `maria`, `juan`, `ana`, `carlos` / `resident-demo-12345`. Local testing only; never on a real deployment.

### Access from another device on the local network

Start the Node server with `HOST` set to `0.0.0.0`, then open `http://<this-computer-LAN-IP>:3000`
from a device on the same trusted Wi-Fi. Allow only TCP port 3000 from the local subnet in Windows Firewall.
Do not forward this port on the router or expose the development server to the public internet.

## What each portal does

**Admin:** totals dashboard; resident add/edit/remove/reset password; room capacity, rent and maintenance status,
live available-bed counts, resident assignment and transfer, and resident lifecycle states (Active, On Leave,
Reserved and Moved Out). A reservation creates a pending Reservation Fee invoice equal to the room's monthly rent,
due on the reservation date. Move-out is blocked until pending and overdue invoices are paid. Residents can submit
a unique OR number and an optional receipt image for administrator verification. The payment table has a Verification
column instead of Action, with search and pagination; admins can review the OR and image, then approve or reject it.
Approval marks the bill Paid; rejection lets the resident resubmit. Payment records (paid / due / overdue, with a 6-month collection chart);
announcements; reminders; visitor log with no approval step for resident-submitted entries; admin-managed curfew schedule.

**Resident:** their room and roommates, payment history, announcements, reminders, their visitors (including self-submitted entries),
and the curfew time. Students do not need to submit curfew check-ins; the system displays the schedule without tracking arrivals.
Visitors submitted from My Visitors are added to the log immediately.
Admins can add an optional PNG, JPEG or WebP room photo (up to 1 MB) in Room Management; residents see the photo
alongside their assigned room.
Residents can attach an optional PNG, JPEG or WebP receipt image (up to 1 MB) when submitting an OR number.
Admins can create separate Downpayment and Monthly Rent bills. Residents can submit an OR number and optional
receipt image for an unpaid bill, submit a monthly payment with an amount when no monthly bill is available, create
and submit an advance payment for next month's rent (including entering an amount if no room is assigned), or submit
a deposit payment with an amount, OR number and optional receipt image.
Submitted proofs remain pending until admin verification. Residents can submit partial payments against bills;
the remaining balance is updated only after verification. A resident may submit one deposit payment, and the admin
verifies it before it is recorded as paid.

Monthly rent bills are generated automatically for active and on-leave residents with an assigned room, starting
in the current month (no earlier months are billed automatically). Each month's due date is the resident's move-in
day; in shorter months, the last calendar day is used. Submitting an OR number leaves the bill due until an
administrator verifies it. Unpaid bills show as Overdue the day after the due date. Amounts are shown in pesos (₱).
Older OR submissions that residents marked Paid automatically are reopened for verification; payments recorded by an
administrator remain unchanged.

## Security notes

Passwords are hashed with PHP's `password_hash`. Sessions use an HTTP-only, SameSite=Strict cookie stored in SQLite.
Every admin route is checked server-side, and write requests must come from the same origin.
Repeated failed sign-ins from one address are temporarily blocked. Keep XAMPP bound to localhost and do not expose
the app directly to the internet.

## Tests

```sh
npm test
```

## Upgrading from the earlier version

This version uses a new database file (`dormitory-v2.sqlite`), so old accounts are not carried over.
Create your admin again with `npm run create-admin`. You can delete the old files: `tenant.html`, `tenant.js`,
`auth-store.js` and the old root-level `index.html`, `login.html`, `login.js`, `app.js`, `styles.css`
(the pages now live in `public/`).
