# Selling this shop to a client: checklist

One client = one separate install: own server (or own container), own domain, own data folder, own password. Never share a data folder between clients.

## Before you start

- [ ] Client's business name, logo (PNG with a clear background is best), stamp or signature picture, brand colour
- [ ] Address, mobile and WhatsApp number, Facebook page, e-mail, opening hours
- [ ] bKash number and bank account details they want customers to see, and whether cash on delivery is allowed
- [ ] Their product list in Excel (SKU, name, price, category) and the photos named `SKU.jpg`
- [ ] A domain they own, and who controls its DNS
- [ ] Where it will run: their own cheap server, or yours under a service agreement

## Install (about an hour with a prepared server)

1. Follow `DEPLOY.md`, section A, with the client's names.
2. Sign in, change the first password to one the client chooses, and give it to them in person or by a private channel.
3. **Settings:** company name, tagline, logo, contact, address, maps link, social links, main colour, website address, **Payment methods**, **Invoice** (prefix such as `ABC-`, BIN/VAT if they have one, terms), **stamp**.
4. **Import** the product list, then **Photos**, then check **Categories** and filters (the *Use suggested filters* button helps).
5. Place a test order from a phone: basket, address, each payment method. Paste it into **Orders**, approve it, record a payment, download the invoice PDF and picture, then cancel the test order so stock comes back.
6. Check the website on a real phone and send a product link on WhatsApp to see the preview card.
7. Take the first backup (`tar czf backup.tar.gz data`) and show the client **Settings → Download data backup**.

## Hand over

- [ ] The two addresses (shop and admin) and the admin password
- [ ] A one-page how-to: add a product, change a price (or hide it), approve an order, record a payment, download an invoice, read the Summary
- [ ] Who pays for the domain and server, and the renewal dates
- [ ] What "free servicing for 1 year" covers and does not cover (write it down; for example: updates, fixes, restoring a backup, up to N hours of changes)
- [ ] Their backup plan: who copies `data/`, how often, where to

## During the service year

- Monthly: check the site and admin open, the disk is not full, and a backup exists that you can actually restore.
- When you improve the program: `git pull && docker compose up -d --build` on their server; their data is not touched.
- Keep a short log per client: server address, domain registrar, install date, version, what you changed.

## Before the year ends

- [ ] Send the renewal offer (updates, backups, support) a month early
- [ ] Hand over a full copy of their `data/` folder and the program if the agreement says so
