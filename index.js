const puppeteer = require('puppeteer');

const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://bbkcgfuyjtmqqrlhqzvo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJia2NnZnV5anRtcXFybGhxenZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTkzMTczNDgsImV4cCI6MjAxNDg5MzM0OH0.K0_Ti1VB5m6KECVauAmQpc6Wg1XflCJPIxN7YnROWGo';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// const north_boundary = -8.3975;
// const south_boundary = -8.7237;
// const east_boundary = 115.3017;
// const west_boundary = 115.1246;

// Pererenan
const west_boundary = 115.1176;
const south_boundary = -8.6383;
const east_boundary = 115.1405;
const north_boundary = -8.6217;

const initial_lat_step = 0.005;
const initial_lon_step = 0.005;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  async function getPlotData(lat, lon) {
    let retryCount = 1;

    while (true) {
      const url = `https://batara.badungkab.go.id/search-detail?coordinate=${lat},${lon}`;
      console.log(`Fetching data from: ${url}`);

      await page.goto(url);

      const data = await page.evaluate(async (lat, lon) => {
        const response = await fetch('https://data.batara.badungkab.go.id/api/certificate/point', {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'id',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            'x': lon.toString(),
            'y': lat.toString(),
          }),
        });

        return response.json();
      }, lat, lon);

      if (data.status === 200 || data.status === 404) {
        if (data.status === 200) {
          return data.data
        } else {
          return null
        }
      } else {
        retryCount++;
        console.log(`Received status ${data.status}. Retrying in a moment...`);
        await delay(retryCount * 1000);
      }
    }
  }

  async function insertPlotData(plotGeoJSON) {
    const certificate = JSON.parse(plotGeoJSON.certificate)
    if (certificate !== null) {
      const geometry = certificate.features[0].geometry

      function convertToMultipolygon(coordinates) {
        const formattedCoordinates = coordinates.map(polygon => {
          const ring = polygon[0].map(coord => `${coord[0]} ${coord[1]}`).join(',');
          return `((${ring}))`;
        });

        const multipolygon = `MULTIPOLYGON(${formattedCoordinates.join(',')})`;
        return multipolygon;
      }

      const dataInsert = {
        name: "Nama Plot",
        location: `POINT(${(plotGeoJSON.center.lng)} ${(plotGeoJSON.center.lat)})`,
        geometry: convertToMultipolygon(geometry.coordinates)
      }

      const { data, error } = await supabase.from('test').insert([dataInsert])

      if (error) {
        console.log(error);
      }
    }
  }

  for (let lat = south_boundary; lat < north_boundary; lat += initial_lat_step) {
    for (let lon = west_boundary; lon < east_boundary; lon += initial_lon_step) {
      const plotData = await getPlotData(lat, lon);
      if (plotData) {
        await insertPlotData(plotData)
        delay(1000)
      }
    }
  }

  const {data, error} = await supabase.rpc("find_gaps_geometry_test", {
    west_boundary,
    south_boundary,
    east_boundary,
    north_boundary
  })

  const geoJson = data

  const outerPolygon = geoJson.coordinates[0];
  
  for (let i = 0; i < outerPolygon.length; i++) {
    const coordinate = outerPolygon[i]; // [longitude, latitude]
    const plotData = await getPlotData(coordinate[1], coordinate[0])
    if (plotData) {
      console.log(plotData);
      await insertPlotData(plotData)
      delay(1000)
    }
  }
  await browser.close();
})();
