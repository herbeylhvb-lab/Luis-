#!/usr/bin/env node
/**
 * Generate a food event flyer for MMS texting via RumbleUp.
 * Uses campaign artwork (headshot, logo) and Jimp for image composition.
 * Output: JPEG under 750KB, optimized for mobile viewing.
 */

const path = require('path');
const { Jimp, loadFont, HorizontalAlign, VerticalAlign } = require('jimp');
const { SANS_128_WHITE, SANS_64_WHITE, SANS_32_WHITE, SANS_32_BLACK, SANS_16_WHITE } = require('jimp/fonts');

const SITE = path.join(__dirname, '..', 'public', 'site');
const OUT = path.join(__dirname, '..', 'public', 'site', 'food-event-flyer.jpg');

// Campaign colors
const NAVY = 0x0A2463FF;
const RED = 0xB22234FF;
const GOLD = 0xC5A44EFF;
const WHITE = 0xFFFFFFFF;
const DARK = 0x1A1A2EFF;

// Flyer dimensions — tall format works great on phones
const W = 1080;
const H = 1350;

async function main() {
  // Load fonts
  const font128w = await loadFont(SANS_128_WHITE);
  const font64w = await loadFont(SANS_64_WHITE);
  const font32w = await loadFont(SANS_32_WHITE);
  const font32b = await loadFont(SANS_32_BLACK);
  const font16w = await loadFont(SANS_16_WHITE);

  // Load artwork
  const headshot = await Jimp.read(path.join(SITE, 'headshot-nobg.png'));
  const logo = await Jimp.read(path.join(SITE, 'logo.jpeg'));

  // Create canvas
  const img = new Jimp({ width: W, height: H, color: NAVY });

  // === TOP BAND — Gold accent stripe ===
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < 8; y++) {
      img.setPixelColor(GOLD, x, y);
    }
  }

  // === HEADER SECTION (y: 20-200) ===
  // "YOU'RE INVITED TO A" - small text
  img.print({ font: font32w, x: 0, y: 40, text: { text: "YOU'RE INVITED TO A", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  // "FREE FOOD" - big title
  img.print({ font: font128w, x: 0, y: 90, text: { text: "FREE FOOD", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  // "EVENT" - second line of title
  img.print({ font: font128w, x: 0, y: 220, text: { text: "EVENT", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  // === RED DIVIDER BAR ===
  for (let x = 140; x < W - 140; x++) {
    for (let y = 365; y < 373; y++) {
      img.setPixelColor(RED, x, y);
    }
  }

  // === EVENT DETAILS SECTION (y: 390-620) ===
  // Gold accent dots
  for (let x = 100; x < W - 100; x++) {
    for (let y = 385; y < 387; y++) {
      if (x % 8 < 4) img.setPixelColor(GOLD, x, y);
    }
  }

  // Details background — slightly lighter navy panel
  const panelColor = 0x0E2D73FF;
  for (let x = 60; x < W - 60; x++) {
    for (let y = 395; y < 640; y++) {
      img.setPixelColor(panelColor, x, y);
    }
  }
  // Panel border
  for (let x = 60; x < W - 60; x++) {
    for (let dy of [395, 639]) {
      img.setPixelColor(GOLD, x, dy);
    }
  }
  for (let y = 395; y < 640; y++) {
    for (let dx of [60, W - 61]) {
      img.setPixelColor(GOLD, dx, y);
    }
  }

  img.print({ font: font32w, x: 0, y: 410, text: { text: "SATURDAY  |  BROWNSVILLE, TX", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  img.print({ font: font64w, x: 0, y: 460, text: { text: "FREE TACOS & MORE", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  img.print({ font: font32w, x: 0, y: 540, text: { text: "COME MEET YOUR CANDIDATE", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });
  img.print({ font: font32w, x: 0, y: 580, text: { text: "& ENJOY GREAT FOOD!", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  // === SECOND RED DIVIDER ===
  for (let x = 140; x < W - 140; x++) {
    for (let y = 655; y < 663; y++) {
      img.setPixelColor(RED, x, y);
    }
  }

  // === HEADSHOT SECTION (y: 680-1100) ===
  // Circular headshot with gold border
  const photoSize = 340;
  const photoCopy = headshot.clone().resize({ w: photoSize, h: photoSize });

  // Create circular mask
  const cx = photoSize / 2;
  const cy = photoSize / 2;
  const radius = photoSize / 2;
  for (let x = 0; x < photoSize; x++) {
    for (let y = 0; y < photoSize; y++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist > radius) {
        photoCopy.setPixelColor(0x00000000, x, y);
      }
    }
  }

  // Draw gold circle border
  const borderR = radius + 5;
  const photoX = (W - photoSize) / 2;
  const photoY = 690;
  for (let x = -borderR; x <= borderR; x++) {
    for (let y = -borderR; y <= borderR; y++) {
      const dist = Math.sqrt(x * x + y * y);
      if (dist <= borderR && dist > radius) {
        const px = Math.round(photoX + cx + x);
        const py = Math.round(photoY + cy + y);
        if (px >= 0 && px < W && py >= 0 && py < H) {
          img.setPixelColor(GOLD, px, py);
        }
      }
    }
  }

  // Composite headshot
  img.composite(photoCopy, photoX, photoY);

  // === NAME TEXT ===
  img.print({ font: font64w, x: 0, y: 1050, text: { text: "LUIS VILLARREAL JR.", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  // === LOGO (below name) ===
  const logoScale = 400 / logo.width;
  const logoCopy = logo.clone().resize({ w: 400, h: Math.round(logo.height * logoScale) });
  const logoX = (W - 400) / 2;
  img.composite(logoCopy, logoX, 1130);

  // === BOTTOM BAND ===
  // Red stripe
  for (let x = 0; x < W; x++) {
    for (let y = H - 50; y < H - 42; y++) {
      img.setPixelColor(RED, x, y);
    }
  }
  // Gold bottom stripe
  for (let x = 0; x < W; x++) {
    for (let y = H - 8; y < H; y++) {
      img.setPixelColor(GOLD, x, y);
    }
  }

  // Website text at bottom
  img.print({ font: font16w, x: 0, y: H - 38, text: { text: "VILLARREALJR.COM", alignmentX: HorizontalAlign.CENTER }, maxWidth: W });

  // === SAVE AS JPEG ===
  const buffer = await img.getBuffer('image/jpeg', { quality: 85 });
  if (buffer.length > 750 * 1024) {
    // Recompress at lower quality if over 750KB
    const buffer2 = await img.getBuffer('image/jpeg', { quality: 60 });
    require('fs').writeFileSync(OUT, buffer2);
    console.log('Saved (compressed):', OUT, Math.round(buffer2.length / 1024) + 'KB');
  } else {
    require('fs').writeFileSync(OUT, buffer);
    console.log('Saved:', OUT, Math.round(buffer.length / 1024) + 'KB');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
