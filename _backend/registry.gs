/**
 * @OnlyCurrentDoc  Limits the script's access to this one spreadsheet.
 */

// Back end for brunoandsally.co.uk: a Google Apps Script attached to the
// website's Google Sheet, which is the one place the guest list, gifts and
// contributions are kept.
//
//   Gifts          the gift list the site shows. Edit it here, not in code.
//   Contributions  one row per guest: who gave what, plus your tickboxes.
//   Guests         who can sign in to the site, by name as on the invitation.
//   Settings       private values, such as the delivery address.
//
// The site only ever gets back the gift list with how much of each is
// covered, and whether a name it asks about is on the guest list. Never the
// guest list itself, or anyone's contact details or messages. The delivery
// address is sent only to a guest who has just reserved a gift to buy.
//
// Setup: in the Sheet, Extensions → Apps Script, paste this file, run setup()
// once, then Deploy → New deployment → Web app, execute as Me, access Anyone.
// Put the /exec URL in SITE_API in index.html.
// After changing this code: Deploy → Manage deployments → edit → New version,
// so the same URL keeps working.

var MONZO_URL = 'https://monzo.me/brunorenucci';
var MONZO_QUERY = 'h=D5OpO6&account_type=joint';

var GIFTS = 'Gifts';
var CONTRIBUTIONS = 'Contributions';
var GUESTS = 'Guests';
var SETTINGS = 'Settings';
var DELIVERY_ADDRESS = 'Delivery address';

var GIFT_HEADERS = ['id', 'name', 'category', 'brand', 'description', 'price', 'target', 'mode', 'link', 'show', 'guest note', 'our notes', 'given so far', 'reserved to buy'];
var CONTRIBUTION_HEADERS = ['When', 'From', 'Guest', 'Gift', 'Gift id', 'Type', 'Amount', 'Monzo reference', 'Contact', 'Message', 'Received', 'Thanked', 'Notes'];
var GUEST_HEADERS = ['Name', 'Invite'];
var TYPE = {buy: 'Buying it', chip: 'Chipping in', message: 'Message only'};
var CATEGORIES = ['kitchen', 'home', 'hosting', 'adventures', 'tech', 'art', 'honeymoon'];
var INVITES = ['Ceremony & reception', 'Evening'];
// buy: a guest buys it and sends it. chip: money only, shared by any number of
// guests. either: one guest can buy it, until anyone chips in, then it's shared.
var MODES = ['buy', 'chip', 'either'];

// ── WEB APP ───────────────────────────────────────────────────────────────────

// ?guest=Name checks a name against the guest list; otherwise, the gift list.
function doGet(e) {
  if (e && e.parameter && 'guest' in e.parameter) {
    return json_({guest: findGuest_(e.parameter.guest)});
  }
  return json_({gifts: gifts_().map(publicGift_)});
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ok: false, error: 'Lots of people are giving at once! Please try again in a moment.'});
  }
  try {
    return json_(give_(JSON.parse(e.postData.contents)));
  } catch (err) {
    console.error(err);
    return json_({ok: false, error: 'Something went wrong. Please try again, or email us directly.'});
  } finally {
    lock.releaseLock();
  }
}

// Records one guest's gift or message. Runs under the script lock, so two
// guests can't both take the last of a gift.
function give_(req) {
  var guest = findGuest_(req.guest);
  if (!guest) {
    return {ok: false, error: 'We couldn’t match you to the guest list. Please sign in again with your name as it appears on your invitation.'};
  }
  var from = clean_(req.name, 100) || guest.name;
  var contact = clean_(req.contact, 200);
  var message = clean_(req.message, 2000);
  if (!message) return {ok: false, error: 'Please leave us a message, even a short one!'};

  if (req.kind === 'message') {
    record_([new Date(), from, guest.name, '', '', TYPE.message, '', '', contact, message]);
    return {ok: true, kind: 'message'};
  }

  var gift = gifts_().filter(function (g) { return g.id === req.giftId; })[0];
  if (!gift) return {ok: false, error: 'That gift isn’t on the list any more. Please choose another.', refresh: true};
  if (gift.full) return {ok: false, error: 'Someone has just covered this one! Please choose another gift.', refresh: true};

  if (req.kind === 'buy') {
    if (gift.mode === 'chip') return {ok: false, error: 'This one can only be chipped in to.'};
    if (gift.covered > 0) {
      return {ok: false, error: 'Others have already chipped in to this one, so it can’t be bought whole any more. You can still chip in.', refresh: true};
    }
    record_([new Date(), from, guest.name, gift.name, gift.id, TYPE.buy, '', '', contact, message]);
    return {ok: true, kind: 'buy', gift: gift.name, link: gift.link, address: setting_(DELIVERY_ADDRESS)};
  }

  if (req.kind === 'chip') {
    if (gift.mode === 'buy') return {ok: false, error: 'This one can’t be chipped in to.'};
    var amount = Math.round(Number(req.amount) * 100) / 100;
    if (!(amount >= 1)) return {ok: false, error: 'Please enter an amount of at least £1.'};
    var left = gift.target === null ? Infinity : round2_(gift.target - gift.covered);
    if (amount > left) {
      return {ok: false, error: 'Only £' + money_(left) + ' is still needed for this one. Could you make it £' + money_(left) + ' or less?', refresh: true};
    }
    var reference = (gift.name + ' from ' + from).slice(0, 60);
    record_([new Date(), from, guest.name, gift.name, gift.id, TYPE.chip, amount, reference, contact, message]);
    return {
      ok: true, kind: 'chip', gift: gift.name, amount: amount, reference: reference,
      monzo: MONZO_URL + '/' + amount.toFixed(2) + '?' + MONZO_QUERY + '&d=' + encodeURIComponent(reference)
    };
  }

  return {ok: false, error: 'Something went wrong. Please try again, or email us directly.'};
}

// ── GIFTS ─────────────────────────────────────────────────────────────────────

// The gifts ticked to show, each with how much is covered so far.
function gifts_() {
  var totals = {};
  rows_(CONTRIBUTIONS).forEach(function (r) {
    var id = String(r['Gift id']).trim();
    if (!id) return;
    var t = totals[id] || (totals[id] = {covered: 0, bought: false});
    if (r['Type'] === TYPE.buy) t.bought = true;
    else t.covered += Number(r['Amount']) || 0;
  });

  return rows_(GIFTS).filter(function (g) { return g.show === true && String(g.name).trim(); }).map(function (g) {
    var id = String(g.id).trim() || slug_(g.name);
    var t = totals[id] || {covered: 0, bought: false};
    var target = Number(g.target) > 0 ? Number(g.target) : null;
    return {
      id: id,
      name: String(g.name).trim(),
      category: String(g.category).trim(),
      brand: String(g.brand),
      description: String(g.description),
      note: String(g['guest note'] || '').trim(),
      price: String(g.price),
      link: String(g.link).trim(),
      mode: MODES.indexOf(g.mode) >= 0 ? g.mode : 'buy',
      target: target,
      covered: round2_(t.covered),
      full: t.bought || (target !== null && t.covered >= target)
    };
  });
}

// What guests may see: how far along each gift is, never the raw total of an
// open fund or anything about who gave.
function publicGift_(g) {
  var open = g.target === null;
  return {
    id: g.id, name: g.name, category: g.category, brand: g.brand, description: g.description, note: g.note,
    price: g.price, link: g.link, mode: g.mode, target: g.target, full: g.full,
    started: g.covered > 0,
    pct: open ? null : g.full ? 100 : Math.min(99, Math.floor(g.covered / g.target * 100)),
    left: open ? null : g.full ? 0 : round2_(g.target - g.covered)
  };
}

// ── GUEST LIST ────────────────────────────────────────────────────────────────

// {name, invite_type} for a name on the Guests tab, or null. Case and extra
// spaces don't matter, the same as the name gate has always worked.
function findGuest_(name) {
  var q = normaliseName_(name);
  if (!q) return null;
  var guests = rows_(GUESTS);
  for (var i = 0; i < guests.length; i++) {
    if (normaliseName_(guests[i]['Name']) === q) {
      return {
        name: String(guests[i]['Name']).trim(),
        invite_type: /ceremony/i.test(guests[i]['Invite']) ? 'ceremony_reception' : 'reception_only'
      };
    }
  }
  return null;
}

function normaliseName_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── SHEET HELPERS ─────────────────────────────────────────────────────────────

function sheet_(name) {
  return SpreadsheetApp.getActive().getSheetByName(name);
}

// A tab's rows as objects keyed by its header row.
function rows_(name) {
  var values = sheet_(name).getDataRange().getValues();
  var head = values.shift();
  return values.map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function setting_(name) {
  var rows = sheet_(SETTINGS).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === name) return String(rows[i][1]).trim();
  }
  return '';
}

function record_(row) {
  sheet_(CONTRIBUTIONS).appendRow(row.map(safe_));
  SpreadsheetApp.flush();
}

// Guests' text is stored as plain text, never run as a formula.
function safe_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function clean_(s, max) {
  return String(s || '').trim().slice(0, max);
}

function slug_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function money_(n) {
  return n % 1 ? n.toFixed(2) : String(n);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── ONE-OFF SETUP ─────────────────────────────────────────────────────────────

// Column widths and the header notes that explain each column, per tab
var LAYOUT = {
  Gifts: {
    widths: [200, 240, 100, 200, 420, 110, 80, 70, 250, 50, 140, 210, 110, 120],
    notes: {
      'id': 'Short code for the gift. Contributions are matched to gifts by it, so don\'t change it once someone has given. For a new gift, use the name in lower case with dashes, e.g. wine-rack.',
      'category': 'Which tab it appears under on the site: kitchen, home, hosting, adventures, tech, art or honeymoon.',
      'price': 'The price shown on the gift card.',
      'target': 'How much in £ covers the gift in full; the progress bar counts towards this. Leave blank for an open fund (no bar, never fills up).',
      'mode': 'buy: a guest buys it and sends it to the delivery address.\nchip: money only, shared by any number of guests.\neither: one guest can buy it outright until anyone chips in; after that it can only be shared.',
      'link': 'Shop link shown on the card. Not shown for chip gifts.',
      'show': 'Untick to hide a gift from the site without deleting it.',
      'guest note': 'Shown on the gift card, e.g. sizes.',
      'our notes': 'Private. Never shown on the site.',
      'given so far': 'Worked out from the Contributions tab.',
      'reserved to buy': 'Yes once a guest has reserved it to buy and send.'
    }
  },
  Contributions: {
    widths: [140, 180, 160, 220, 200, 110, 90, 300, 200, 420, 80, 80, 220],
    notes: {
      'When': 'The website adds a row each time a guest gives or sends a message. You can add rows yourselves too, e.g. for cards or cash on the day: fill in Gift id, Type and Amount for it to count towards that gift.\nDeleting a row frees that gift up again.',
      'From': 'The name they gave, which can include whoever they are giving with.',
      'Guest': 'The name they signed in to the site with, from the Guests tab.',
      'Type': 'Buying it, Chipping in or Message only. A Buying it row marks the gift as gifted.',
      'Amount': 'What the guest said they would send. Tick Received once it has arrived.',
      'Monzo reference': 'The reference filled in on their Monzo payment, to match it up.',
      'Received': 'Tick when the money or parcel arrives.',
      'Thanked': 'Tick once you have sent a thank-you.'
    }
  },
  Guests: {
    widths: [240, 180],
    notes: {
      'Name': 'Who can sign in to the website and RSVP. Write each name the way the guest will type it, as on their invitation; capitals and extra spaces don\'t matter.',
      'Invite': 'Ceremony & reception, or Evening. Decides which details they see.'
    }
  },
  Settings: {
    widths: [160, 320],
    notes: {'Value': 'Private values the website uses. The delivery address is shown only to a guest who has just reserved a gift to buy.'}
  }
};

// Adds the formatting, header notes, tickboxes, dropdowns and running totals.
// Creates any tab that's missing, but never changes the gifts, guests or
// contributions already there, so it's safe to run again.
function setup() {
  var ss = SpreadsheetApp.getActive();
  var checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  var oneOf = function (list) {
    return SpreadsheetApp.newDataValidation().requireValueInList(list, true).build();
  };

  var gifts = tab_(ss, GIFTS, GIFT_HEADERS);
  gifts.getRange('C2:C').setDataValidation(oneOf(CATEGORIES));
  gifts.getRange('G2:G').setNumberFormat('£#,##0');
  gifts.getRange('H2:H').setDataValidation(oneOf(MODES));
  gifts.getRange('J2:J').setDataValidation(checkbox);
  // Running totals per gift from Contributions, extending to new gifts
  gifts.getRange('M1').setFormula('={"given so far";ARRAYFORMULA(IF(A2:A="",,SUMIFS(Contributions!G2:G,Contributions!E2:E,A2:A)))}');
  gifts.getRange('M2:M').setNumberFormat('£#,##0.00');
  gifts.getRange('N1').setFormula('={"reserved to buy";ARRAYFORMULA(IF(A2:A="",,IF(COUNTIFS(Contributions!E2:E,A2:A,Contributions!F2:F,"' + TYPE.buy + '"),"Yes","")))}');

  var contributions = tab_(ss, CONTRIBUTIONS, CONTRIBUTION_HEADERS);
  contributions.getRange('A2:A').setNumberFormat('d mmm yyyy, h:mm');
  contributions.getRange('G2:G').setNumberFormat('£#,##0.00');
  contributions.getRange('K2:L').setDataValidation(checkbox);

  var guests = tab_(ss, GUESTS, GUEST_HEADERS);
  guests.getRange('B2:B').setDataValidation(oneOf(INVITES));

  var settings = tab_(ss, SETTINGS, ['Setting', 'Value']);
  if (settings.getLastRow() === 1) settings.appendRow([DELIVERY_ADDRESS, '']);
  settings.getRange('A2:B').setVerticalAlignment('top').setWrap(true);
}

// The named tab, created with its header row if missing, then laid out and
// annotated from LAYOUT.
function tab_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  var head = sheet.getRange(1, 1, 1, headers.length);
  head.setFontWeight('bold').setBackground('#EDF2ED');
  sheet.setFrozenRows(1);
  var layout = LAYOUT[name];
  layout.widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  head.setNotes([headers.map(function (h) { return layout.notes[h] || ''; })]);
  return sheet;
}
