require("dotenv").config();
const puppeteer = require("puppeteer");

const { createClient } = require("@supabase/supabase-js");
const { redis } = require("./lib/redis");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// const north_boundary = -8.3975;
// const south_boundary = -8.7237;
// const east_boundary = 115.3017;
// const west_boundary = 115.1246;

/*
  1.So first we must create function in supabase
    CREATE OR REPLACE FUNCTION generate_series_step(min float8, max float8, step float8)
    RETURNS TABLE (result float8) AS $$
    BEGIN
      result := min;
      WHILE result <= max LOOP
        RETURN NEXT;
        result := result + step;
      END LOOP;
      RETURN;
    END;
    $$ LANGUAGE plpgsql;

  2. Create function again in supabase for get coordinates gap, this will return data of line coordinate
  CREATE OR REPLACE FUNCTION find_gap_coordinates_plots(
  in west_boundary double precision,
  in south_boundary double precision,
  in east_boundary double precision,
  in north_boundary double precision,
  in step double precision
  )
  RETURNS TABLE(x double precision, y double precision) AS $$
  DECLARE
    bali_bbox geometry;
    multipolygon geometry;
  BEGIN
    bali_bbox := ST_MakeEnvelope(west_boundary, south_boundary, east_boundary, north_boundary, 4326);

    SELECT ST_Union(geometry::geometry) INTO multipolygon FROM plots;

    RETURN QUERY
    SELECT ST_X(point.geom), ST_Y(point.geom)
    FROM (
      SELECT ST_SetSRID(ST_Point(x.result, y.result), 4326) AS geom
      FROM generate_series_step(west_boundary, east_boundary, step) AS x,
          generate_series_step(south_boundary, north_boundary, step) AS y
    ) AS point
    WHERE NOT ST_Within(point.geom, multipolygon);
  END;
  $$ LANGUAGE plpgsql;

  3. Create function for delete a duplicate data from database
  CREATE OR REPLACE FUNCTION delete_duplicates() RETURNS VOID AS $$
  BEGIN
    WITH duplicates AS (
      SELECT id, ROW_NUMBER() OVER(PARTITION BY geometry ORDER BY id) AS rn
      FROM test
    )
    DELETE FROM test
    WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);
  END;
  $$ LANGUAGE plpgsql;
*/

// Pererenan
const west_boundary = 115.1176;
const south_boundary = -8.6383;
const east_boundary = 115.1405;
const north_boundary = -8.6217;

const initial_lat_step = 0.005;
const initial_lon_step = 0.005;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertZoningArea(geom) {
  const { data, error } = await supabase.rpc("is_geography_exists", {
    input_type: "zone",
    input_geometry: geom.zoning_geom,
  });

  if (error) {
    console.log("[FIND_ZONING :]", error);
    return null;
  }

  if (!data) {
    const { data, error } = await supabase.from("zoning_areas").insert([geom]);

    if (error) {
      console.log("[INSERT_ZONING_AREA] :", error);
      return null;
    }
    console.log("[INSERT_ZONING_AREA] : SUCCESS");
  } else {
    console.log("[ZONING_ALREDY_REGISTERED]");
    return null;
  }

  // }
}

async function findGaps(step) {
  let data = [];
  let start = 0;
  let size = 1000;
  let hasMore = true;
  let errorFindGap;

  while (hasMore) {
    const {
      data: gaps,
      error,
      count,
    } = await supabase
      .rpc("find_gap_coordinates_plots", {
        west_boundary,
        south_boundary,
        east_boundary,
        north_boundary,
        step,
      })
      .select("*", { count: "exact" })
      .range(start, start + size - 1);

    if (error) throw error;

    data = [...data, ...gaps];
    start += size;
    hasMore = (count ?? 0) > start;

    errorFindGap = error;
  }

  return { data, errorFindGap };
}

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  async function getPlotData(lat, lon) {
    let retryCount = 1;

    while (true) {
      const cachedValue = await redis.get(`${lat} ${lon}`);

      if (cachedValue) {
        console.log(`Get data from cache : ${lat} ${lon}`);
        return JSON.parse(cachedValue);
      }

      const url = `https://batara.badungkab.go.id/search-detail?coordinate=${lat},${lon}`;
      console.log(`Fetching data : ${lat} ${lon}`);

      await page.goto(url);

      const data = await page.evaluate(
        async (lat, lon) => {
          const response = await fetch(
            "https://data.batara.badungkab.go.id/api/certificate/point",
            {
              method: "POST",
              headers: {
                accept: "application/json, text/plain, */*",
                "accept-language": "id",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                x: lon.toString(),
                y: lat.toString(),
              }),
            }
          );

          return response.json();
        },
        lat,
        lon
      );

      if (data.status === 200 || data.status === 404) {
        await redis.set(`${lat} ${lon}`, JSON.stringify(data.data));

        if (data.status === 200) {
          return data.data;
        } else {
          return null;
        }
      } else {
        retryCount++;
        console.log(`Received status ${data.status}. Retrying in a moment...`);
        await delay(20000);
      }
    }
  }

  async function insertPlotData(plotGeoJSON) {
    function convertToMultipolygon(coordinates) {
      const formattedCoordinates = coordinates.map((polygon) => {
        const ring = polygon[0]
          .map((coord) => `${coord[0]} ${coord[1]}`)
          .join(",");
        return `((${ring}))`;
      });

      const multipolygon = `MULTIPOLYGON(${formattedCoordinates.join(",")})`;
      return multipolygon;
    }

    const certificate = JSON.parse(plotGeoJSON.certificate);

    const { geojson, ...information } = plotGeoJSON.territorials.geom[0];

    if (geojson !== null) {
      await insertZoningArea({
        zone_code: plotGeoJSON.territorials.geom[0].zone.parent.code,
        name: plotGeoJSON.territorials.geom[0].zone.parent.name,
        center: `POINT(${plotGeoJSON.center.lng} ${plotGeoJSON.center.lat})`,
        zoning_geom: convertToMultipolygon(JSON.parse(geojson).coordinates),
        information: JSON.stringify(information),
      });
    }

    if (certificate !== null) {
      const geometry = certificate.features[0].geometry;

      const { data, error } = await supabase.rpc("is_geography_exists", {
        input_type: "plot",
        input_geometry: convertToMultipolygon(geometry.coordinates),
      });

      if (error) {
        console.log("[FIND_PLOT :]", error);
        return null;
      }

      if (data) {
        console.log("[PLOTS_ALREDY_REGISTERED]");
      } else {
        const dataInsert = {
          // name: "Nama Plot",
          zone_code: plotGeoJSON.territorials.geom[0].zone.parent.code,
          center: `POINT(${plotGeoJSON.center.lng} ${plotGeoJSON.center.lat})`,
          geometry: convertToMultipolygon(geometry.coordinates),
        };

        const { data, error } = await supabase
          .from("plots")
          .insert([dataInsert]);
        if (error) {
          console.log("[INSERT_PLOT_DATA] :", error);
        }

        console.log("[INSERT_PLOT_DATA] : SUCCESS");
      }
    }
  }

  // Comment this block code when you just want to find a gap
  for (
    let lat = south_boundary;
    lat < north_boundary;
    lat += initial_lat_step
  ) {
    for (
      let lon = west_boundary;
      lon < east_boundary;
      lon += initial_lon_step
    ) {
      const plotData = await getPlotData(lat, lon);
      if (plotData) {
        await insertPlotData(plotData);
      }
    }
  }

  // Find a gap
  async function findGapsAndRescan() {
    console.log("[FINDING_GAP]");

    const { data, errorFindGap } = await findGaps(0.0005);

    if (errorFindGap) {
      return console.log(errorFindGap);
    }

    for (line of data) {
      const plotData = await getPlotData(line.y, line.x);
      if (plotData) {
        await insertPlotData(plotData);
      }
    }

    const { data: gap2, errorFindGap: errorFindGap2 } = await findGaps(0.0003);

    if (errorFindGap2) {
      return console.log(errorFindGap2);
    }

    for (line of gap2) {
      const plotData = await getPlotData(line.y, line.x);
      if (plotData) {
        await insertPlotData(plotData);
      }
    }

    // Function to delete duplicate data
    const { data: duplicate, error: duplicateError } = await supabase.rpc(
      "delete_duplicates"
    );
    if (duplicateError) {
      return console.log(duplicateError);
    }
  }

  await findGapsAndRescan();

  await browser.close();
})();
