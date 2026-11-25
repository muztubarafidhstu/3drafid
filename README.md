# Shop catalog: your own product website

A fast website for about 1,000 products. Customers browse, add products to a basket, give their delivery address, choose **cash on delivery, bKash or bank transfer**, and send the order to your WhatsApp. In the admin each order waits for your approval; approving it takes the stock down by itself, you record the payment, and you download a professional **invoice (PDF or picture)** with your logo, company details and stamp. A Summary page shows your sales and profit.

**There is no Publish button.** The admin and the customer website are one program. Whatever you change in the admin (a price, a photo, your phone number) is on the customer website a few seconds later, by itself. A small green box at the top of the admin shows "Website is up to date".

```
Customers ──▶ 3d.example.com          (the shop, public)
You       ──▶ 3d-admin.example.com    (the admin, password protected)
              └─ one program, one data folder (products, orders, photos, password)
```

For an online server (Docker, free HTTPS) read **DEPLOY.md**. To hand a finished shop to a client read **CLIENT-HANDOVER.md**.


## 1. Run it on your own computer (to try it, or to work offline)

1. Install **Node.js** (the LTS version) from https://nodejs.org
2. Unzip this folder anywhere, for example `C:\shop-catalog`.
3. **Windows:** double-click `start.bat`. The first run installs what it needs, then opens the admin in your browser.
   **Mac / Linux:** open a terminal in the folder and run `npm install`, then `npm start`. Open http://localhost:3000.

Leave the black window open while you work. On your own computer the admin is at http://localhost:3000 and the customer website at http://localhost:3001; both update together.

> On your own computer a password is optional (set one with `npm run set-password`). Once the shop is online the password is always required.

## 2. Fill in your shop (first time, in this order)

1. **Settings**: company name and a short line about the business, **logo** (upload a picture, it also becomes the browser-tab icon), **WhatsApp number**, phone, email, **address**, Google Maps link, opening hours, Facebook / Instagram / YouTube / TikTok links, website address, main colour and the big headline on the home page. For the WhatsApp number you can type `01712345678`; it is turned into `8801712345678` automatically. Contact details appear in a "Find us" section on the home page and in the footer; anything you leave empty is simply not shown. The **Payment methods** group holds your bKash number, bank account details and the cash-on-delivery switch (customers see these on the basket page, so write only what the public may see). Under **Invoice** you set the invoice number prefix, BIN/VAT, terms and notes, and you can upload a **stamp or signature** picture that is printed on every invoice (it is never put on the website). Changes appear on the website by themselves a few seconds after you save.
2. **Import**: upload your product list (Excel `.xlsx` or `.csv`; from Google Sheets use *File → Download → Excel*). Click **Download sample template** to see the layout. The sample template has 3D-printing examples (filament with a discount and a refill pack, a nozzle, a heated bed, printers with Brand / Technology / AMS / Version, a lubricant). Columns are recognised automatically, English or Bangla headings:

   | Column | Needed | Example |
   |---|---|---|
   | SKU / Code | yes, unique per product | `FIL-PLA-BLK` |
   | Name | yes | `PLA+ Filament 1.75mm 1kg - Black` |
   | Price | yes, unless Show price is `no` | `1650`, `৳1,650`, `Tk 1650`, `1650/-` all work |
   | Sale price | no (discount) | `1450`. Type `0` to end a discount |
   | Show price | no | `yes` / `no`. `no` = customers see "Ask price on WhatsApp" |
   | Category | no (created automatically) | `Filament`, `Nozzles`, `Heat bed` |
   | Brand, Colour, Material, Pack, Technology, AMS, Version | no (become customer filters, see below) | `Sunlu`, `Black`, `PLA+`, `Spool` / `Refill`, `FDM/FFF` or `Resin`, `With AMS`, `Global` or `Chinese` |
   | Buying cost | no, **private** (also `Cost`, `Purchase price`) | `1100`. Used only for your profit page, never published |
   | Stock qty | no (also `Quantity`, `Qty`) | `12`. Orders take from it automatically, see *Orders* below |
   | Description | no | |
   | In stock | no | `yes` / `no`. Ignored for a product that has a Stock qty |
   | Image 1, Image 2 | no | `FIL-PLA-BLK.jpg`, `FIL-PLA-BLK-2.jpg` |
   | Featured, Shown on site | no | `yes` / `no` |

   You see a check before anything is saved ("will add 120, update 30, 2 have problems"). Importing again later **updates by SKU**, and blank cells never erase existing data. So you can keep your Excel as the master and re-import it.
3. **Photos**: drag in the photos, or a whole folder, all at once. Name them `SKU.jpg` for photo 1 and `SKU-2.jpg` for photo 2 (or use the photo columns above). Your 5 MB originals are shrunk automatically (about 1600 px, WebP) and the originals are not kept. Safe to run again.
   *iPhone HEIC photos are not supported: export them as JPG first.*
4. **Products**: check the list. You can change price, buying cost, stock quantity, category and visibility right in the table, edit a product, or add one by hand (**+ Add product**, then add its photos). In the product form the **Buying cost** and **Stock quantity** boxes are optional; with a cost entered the form shows your profit per item.

## Prices: show, hide, discount

Every product has a **Show price on the website** switch (in *Add product / Edit product*, and as the **Show price** column in the product list).

- **Switch ON:** customers see the price. Add a **Discount price** (or type **% off**, the other box fills itself) and customers see the new price, the old price crossed out, a red "12% OFF" tag and "You save ৳200". The form shows exactly what customers will see before you save.
- **Switch OFF:** customers see **Ask price on WhatsApp** instead of a price. The button opens WhatsApp with the product name, code and link already typed. The price and discount are also left out of the website files, the page title and the data search engines read, so nobody can find them by viewing the page source. Your stored price is kept, so you can switch it back on any time.
- **Basket:** customers can still add a no-price product. The basket adds up only the products that have a price, and the WhatsApp message tells you which items need a price from you.
- **Sorting by price** always puts the no-price products last.
- The discount must be lower than the price. If you later lower the price below an existing discount, the discount is removed automatically and you are told.
- A change appears on the customer website by itself within a few seconds, a hidden price included: the old price is removed from the website files at once.

## Orders: wait for approval, then stock goes down by itself

Ordering is still on WhatsApp (no online payment), but your admin keeps the books:

1. A customer fills the basket and sends the order to your WhatsApp. The message lists each product with its **SKU**, the quantity and the price, and also carries the customer's **name, phone, delivery address and payment choice** (and the bKash transaction ID or bank reference if they typed one). The basket will not open WhatsApp until name, mobile number and address are filled in, and it remembers them on that phone for next time.
2. In the admin open **Orders → Paste WhatsApp order**, paste that message and press **Create order**. (Or press **+ New order** and pick the products yourself, for a phone call or a walk-in customer.) Products are found by SKU, so do not change the SKU lines in the message. Codes it cannot find are listed so you can add the right product by hand.
3. The order is now **Waiting for approval**. Nothing is taken from stock yet. Open it with **Review** and correct anything: quantities, prices (for example a negotiated price), a discount on the whole order, the delivery fee, the customer details. The totals and your profit update as you type.
4. Press **Approve order**. Your corrections are saved, and the quantities are **taken out of stock**. A product with a *Stock qty* goes down by the ordered amount; at 0 it shows as out of stock on the website. If an order asks for more than you have, you are asked first: *Approve anyway* takes what is there and sets the stock to 0.
5. **Cancel order** on an approved order puts its stock back. Cancelling a waiting order just closes it. Only waiting orders can be edited; to change an approved one, cancel it and enter it again. **Message customer** opens WhatsApp with a short "your order is confirmed" text.

Good to know:

- **A product without a Stock qty is not counted.** Its *In stock* switch stays in your hands. Give a product a Stock qty to let orders count it down (you can also put a Stock qty column in your Excel).
- The number badge on the **Orders** tab shows how many orders are waiting.
- Stock changes reach the customer website by themselves a few seconds after you approve or cancel.
- Orders and customer names, phones and addresses stay in the `data` folder on the server. They are never put in the website files.
- Orders are captured by pasting the WhatsApp message. Picking them up automatically would need a small online service; it is not part of this package.

## Profit: the Summary page

**Summary** is the first page of the admin. Pick a period (today, last 7 days, this month, last month, this year, all time, or your own dates) and see:

- **Sales**, **Buying cost** and **Profit** (with the margin %) from **approved** orders, a bar chart by day (by month for long periods), best sellers by profit, sales by category, products running low (3 or fewer in stock), and the value of your stock at buying cost.
- **How profit is counted:** (selling price after discounts) minus (buying cost), for approved orders, on the day each order was approved. An order discount is shared across its lines. The **delivery fee is not counted** as sales or profit. Cancelled and waiting orders are not counted.
- **Products with no buying cost** cannot give a profit. Their sales are shown on a yellow notice and left out of the profit, so the profit is never overstated. Add the cost to those products to include them. An approved order keeps the costs it was approved with. For a waiting order, a blank cost is filled in from the product at the moment you press Approve (you can also type the cost on the order line yourself).
- **Download these orders (CSV for Excel)** exports the period's approved orders, one row per product line (dates are in UTC), for your bookkeeping. The order discount and delivery fee are repeated on every row of the same order, so do not add those two columns up.
- The **buying cost is private**: it is never written into the website files, and neither are stock counts or orders.

## Filters: colour, material, spool or refill

Customers can narrow a category down with filters. **Each category has its own filters**, so Filament can have *Brand, Colour, Material, Pack* while Printers has *Brand, Technology (FDM/FFF or Resin), AMS (With / Without), Version (Global / Chinese)* and Nozzles has *Size, Material*. Set them up once:

1. **Categories** tab → type the filters of a category in the **Filters** box, separated by commas. Next to Filament, 3D Printers and Nozzles the admin offers a one-click **Use suggested filters** button. (Up to 8 per category.)
2. **Products** → edit a product. Under its category the form now shows one box per filter. Type `Black`, `PLA+`, `Refill`. Boxes suggest the values you already used, so you do not end up with *Black* and *black* as two choices (they are merged into one spelling automatically).
3. **From Excel:** just add columns named `Colour`, `Material`, `Pack`, `Brand` (also `Color`, `Diameter`, `Size`, `Weight`, `Model`, `Nozzle size`; any other column you can tick yourself on the Import screen). The Import screen ticks them as filters and adds them to the product's category for you.

What customers see:

- **Phone:** right under the category title a **quick filter bar** shows rows of chips: Category, then one row per filter (Brand, Colour with a colour dot, Material, Pack, or Technology, AMS, Version for printers). One tap filters, another tap clears. Each row shows the top choices and a **More…** chip opens the full list. The **Filters** button opens the same choices as a sheet.
- **Phone (sheet):** Pick as many options as they like and press *Show N products*. **Computer:** a filter column on the side.
- Several options in one group mean "or" (Black *or* White). Different groups mean "and" (Black *and* PLA+ *and* Refill).
- The number next to each option shows how many products it would give. Options with no products are hidden. Long lists (for example 40 colours) show the most common ones with **Show all**.
- Colour filters show a little colour dot. Chosen filters appear as chips above the products, and the page address keeps them, so a filtered list can be shared on WhatsApp.
- A category with no filters set up shows the plain list, nothing extra.
- Filter values also appear on the product page as a small spec list (Colour: Black, Material: PLA+ ...).

Notes: removing a filter from a category deletes its values from that category's products (you are asked first). Moving a product to another category clears the values that category does not use, and tells you. Filters, like prices, appear on the website by themselves.

## Payment and invoices

- **Customer side:** on the basket page the customer enters name, mobile and delivery address (house or flat, road or street, area, district), then picks how to pay. *Cash on delivery* needs nothing more. *bKash* shows your number and an optional box for the transaction ID. *Bank transfer* shows your account details and an optional reference box. Only the methods you set up are offered.
- **Admin side:** open an order. The **Payment** box holds the method, **Amount received** and the transaction ID. **Mark fully paid** fills the amount in one click. For an approved order press **Save payment** (the rest of an approved order stays locked). The order dialog then shows *Paid* and *Still to pay*.
- **Invoice:** every order has **Invoice PDF** and **Invoice image** buttons. The top of the invoice shows your logo, company name and tagline, address, mobile / WhatsApp, Facebook, e-mail and website. Below it: the customer's name, mobile and delivery address, the products, subtotal, discount, delivery, total, **Paid** and **Due**, amount in words, payment method, your terms, your stamp and a signature line. A paid-in-full order gets a green *Paid* bar and watermark, a cancelled one a red *Cancelled* watermark. A waiting order is titled *Proforma invoice*, an approved one *Invoice*. Bangla names and addresses print correctly, and a long order continues on a second page.
- The invoice never shows your buying cost or profit.
- Payment details (bKash number, bank account) are public by design: customers see them on the basket page. Do not put anything there that you would not say out loud to a customer.

## 3. Put it online

See **DEPLOY.md**. In short: one small server (any cheap VPS, or a PC with a free Cloudflare Tunnel), two names such as `3d.yourdomain.com` and `3d-admin.yourdomain.com`, and `docker compose up -d`. HTTPS certificates are automatic. The data folder is the only thing to back up (the admin also has **Settings → Download data backup**).

For a plain static copy of the website (for example to host on a CDN) `npm run build` writes the customer website to `dist/`. Orders, the admin and automatic updates need the running program, so the static copy has no live updates.

## GitHub (code only)

This repository holds the program, not your shop. `.gitignore` keeps `data/` (products, buying costs, orders, customer phone numbers and addresses, photos, the password hash) and `dist/` out of Git, so nothing private is ever uploaded.

## Good to know

- **Back up the `data` folder.** It holds all your products, orders, buying costs and photos. Copy it to a USB drive or Google Drive now and then. The admin also keeps the last 20 automatic copies of the product list and orders in `data/backups`. It contains customer names and phone numbers and your costs, so never upload it; only `dist` goes online.
- Customers see **only products marked "shown on site"**. Out-of-stock products stay visible but show "Ask on WhatsApp" instead of the basket button.
- **The look:** the shop and the admin use a bright 3D-printer theme: a colourful animated background with floating printing shapes, a printer that keeps printing a colourful vase on the home page, a moving category ribbon, colourful category tiles, a "How to order" strip, a "Find us" contact section, keycap-style buttons, and in the admin a welcome banner, coloured tabs and charts that grow in. The **Main colour** in Settings changes the shop's main colour. On phones everything is sized a little smaller so it does not feel zoomed in. If a visitor's device is set to reduce motion, the movement is switched off automatically.
- The basket remembers only what was added, not prices, so customers always see your current price and name.
- Ordering: the basket button opens WhatsApp with a ready message listing the products (with SKU), quantities and total. You confirm the order and delivery in the chat, then enter it in **Orders** (see above).
- Import only spreadsheets you made yourself. The Excel-reading library (SheetJS 0.18) has published security advisories about specially crafted files and no newer fixed version on npm. That matters little for an admin that runs only on your own computer, but do not import files from strangers.
- Ports: the admin uses 3000 and the preview 3001. If one is busy, start with `PORT=3010 npm start` (Mac/Linux) or `set PORT=3010` then `npm start` (Windows).

## For a developer

`npm test` runs the automated tests (71). They include a scan of every published file to make sure a hidden price, a buying cost, a stock count or an order never appears. Code: `server.js` (admin API), `lib/` (store, importer, orders and profit, photo pipeline, site builder, auto-publisher, login, invoice drawing), `admin/` (admin UI), `assets/` (storefront CSS and JS). Data lives in `data/store.json` (products, settings, orders) and `data/images`. Environment variables: `PORT`, `PREVIEW_PORT`, `DATA_DIR`, `DIST_DIR`, `ADMIN_HOST`, `SITE_HOST`, `SITE_URL`, `ADMIN_PASSWORD`, `HOST`, `TRUST_PROXY`, `COOKIE_SECURE`, `SHOP_TZ` (default `Asia/Dhaka`). See `.env.example`.
