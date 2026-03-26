'use strict';
const { chromium } = require('playwright');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function normalizeApos(s) { return (s||'').replace(/[\u00B4\u2018\u2019\u02BC`]/g,"'"); }

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ userAgent: USER_AGENT });
  const page = await ctx.newPage();
  const url  = `https://www.cernyrytir.cz/index.php3?akce=3&jmenokarty=${encodeURIComponent('lightning bolt')}&edice_magic=0&submit=Vyhledej`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const cards = await page.evaluate(() => {
    const allRows = Array.from(document.querySelectorAll('tr'));
    const result  = [];
    for (let i = 0; i < allRows.length; i++) {
      const cells = Array.from(allRows[i].querySelectorAll('td'));
      if (cells.length !== 4) continue;
      const rowText = allRows[i].innerText || '';
      if (!rowText.includes('Kč') || !rowText.includes('ks')) continue;
      const priceM = (cells[2].innerText||'').match(/([\d\s]+)\s*Kč/);
      if (!priceM) continue;
      const price   = parseInt(priceM[1].replace(/\s/g,''),10);
      const qtyM    = (cells[1].innerText||'').match(/(\d+)\s*ks/i);
      const quantity = qtyM ? parseInt(qtyM[1],10) : 0;
      let name='', edition='';
      for (let j=i-1; j>=Math.max(0,i-6); j--) {
        const pc = Array.from(allRows[j].querySelectorAll('td'));
        if (pc.length===2 && !edition) {
          const hasImg = Array.from(pc[0].querySelectorAll('img')).some(img=>(img.getAttribute('src')||'').includes('/kusovky/'));
          if (hasImg) edition = (pc[0].innerText||'').replace(/\s+/g,' ').trim();
        }
        if (pc.length===3 && !name) {
          const t = (pc[1].innerText||'').replace(/\s+/g,' ').trim();
          if (t && t.length>1 && t.length<=80) name=t;
        }
        if (name && edition) break;
      }
      if (!name) continue;
      result.push({ name, edition, price, quantity });
    }
    return result;
  });

  const ed3 = cards.filter(c => c.edition.toLowerCase().includes('3rd') || c.edition.toLowerCase().includes('revised'));
  console.log('\n=== 3rd Edition výsledky ===');
  ed3.forEach(c => console.log(`  "${c.name}" | ${c.edition} | ${c.price} Kč | ${c.quantity} ks`));
  console.log(`\n=== Všechny CR výsledky (${cards.length}) ===`);
  cards.forEach(c => console.log(`  "${c.name}" | ${c.edition} | ${c.price} Kč | ${c.quantity} ks`));

  await browser.close();
}
main().catch(console.error);
