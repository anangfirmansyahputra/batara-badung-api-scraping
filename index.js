const fs = require('fs');
const puppeteer = require('puppeteer');

const initialX = 115.12133064885461;
const initialY = -8.6507827703452;
const increment = -0.0002;

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  let x = initialX;
  let y = initialY;

  const landPlotsData = [];

  for (let i = 0; i < 10; i++) {
    const url = `https://batara.badungkab.go.id/search-detail?coordinate=${y},${x}`;
    console.log(`Fetching data from: ${url}`);

    await page.goto(url);

    const data = await page.evaluate(async (x, y) => {
      const response = await fetch('https://data.batara.badungkab.go.id/api/certificate/point', {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'id',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          'x': x.toString(),
          'y': y.toString(),
        }),
      });

      return response.json();
    }, x, y);

    if (data.data) {
      landPlotsData.push(data.data);
    }
    x += increment;
    y -= increment;
  }

  await browser.close();

  const outputPath = 'land-plots.json';
  fs.writeFileSync(outputPath, JSON.stringify(landPlotsData, null, 2));
  console.log(`Data has been saved to ${outputPath}`);
})();
