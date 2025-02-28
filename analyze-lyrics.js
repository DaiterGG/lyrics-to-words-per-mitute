import fs from "node:fs";
import sqlite3Module from "sqlite3";
const { verbose } = sqlite3Module;
const sqlite3 = verbose();

// NOTE:
// [1.0, 0.0]
// # 1.0 song is one line repeated
// # 0.67 song is two lines repeated (50/50)
// # 0.3 - 0.1 ~ regular song with choruses
const MAX_REPEATS = .2;
// NOTE: filter out short songs
const MIN_LINES = 20;
const MIN_WPM = 45;
const MAX_WPM = 55;
// /[^\x00-\x7F]/ is strict english
const CHECK_REGEX = /[^\x00-\x7F]/;

// NOTE:
// 2.000.000 is about 9gb of ram
// if filters are not strict enough
// lower -> slower
const PROCESS_STEP = 1000000;

const DB_PATH = "db.sqlite3";
const FINAL_NAME = `result${MIN_WPM}-${MAX_WPM}.txt`;

// tracks[track_id] = { tries, ?result }
// tries: null|0-(MAX_TRIES - 1) - can keep trying
// tries: MAX_TRIES - give up
// tries: MAX_TRIES + 1 - found proper result
// NOTE: try more lyrics of the same song before giving up
const MAX_TRIES = 3;

function calculateWPM(content) {
  // Parse timestamps and lyrics
  const lines = content.split("\n");
  const entries = parseLyrics(lines);

  const wpms = [];
  let repeats = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    const current = entries[i];
    const next = entries[i + 1];

    //found non English characters
    if (CHECK_REGEX.test(current.text)) {
      return null;
    }

    // no empty lines in math
    if (current.text.length < 3) {
      continue;
    }

    // all repeats (exponential)
    for (let j = 0; j < entries.length; j++) {
      if (j !== i && entries[j].text === entries[i].text) {
        repeats++;
      }
    }
    // line can't be too slow (below 1 character per second)
    const duration = Math.min(
      1 * current.text.length,
      next.time - current.time,
    );

    if (duration > 0 && current.text) {
      const cpm = (current.text.length / duration) * 60; // Characters per minute
      const wpm = cpm / 5; // 1 word = 5 characters
      wpms.push(wpm);
    }
  }

  // [1.0, 0.0]
  const repeats_val = Math.sqrt(repeats) / entries.length;

  // if (repeats_val > .3) {
  //   console.log(`Skipped file: ${repeats}\n${repeats_val}\n${content}`);
  // }

  if (wpms.length > MIN_LINES && repeats_val < MAX_REPEATS) {
    const sorted = wpms.sort((a, b) => b - a);
    const top5 = sorted.slice(0, 5);
    const topMIN_LINES = sorted.slice(0, MIN_LINES);
    let average = topMIN_LINES.reduce((a, b) => a + b, 0) /
      topMIN_LINES.length;

    // if difference is too big, use top5
    if (topMIN_LINES[topMIN_LINES.length - 1] * 2 < topMIN_LINES[0]) {
      average = top5.reduce((a, b) => a + b, 0) / top5.length;
    }

    if (average > MIN_WPM && average < MAX_WPM) {
      return {
        top5,
        repeats: Number(repeats_val.toFixed(2)),
        average: Number(average.toFixed(0)),
      };
    }
  }

  return null;
}
export function parseLyrics(lines) {
  const timeRegex = /\[(\d{2}):(\d{2}\.\d{2})\]/;
  const entries = [];
  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const minutes = parseInt(match[1]);
      const seconds = parseFloat(match[2]);
      entries.push({
        time: minutes * 60 + seconds,
        text: line.split("] ")[1]?.trim() || "",
      });
    }
  }
  return entries;
}

function parseName(name, artist) {
  const new_name = name.split(" ").join("").split("-")[0]
    .split("[")[0].split("(")[0].toLowerCase().split("feat")[0].split(
      "ft",
    )[0];
  const new_artist = artist.split(" ").join("").split("-")[0].split("[")[0]
    .split("(")[0].toLowerCase().split("feat")[0].split(
      "ft",
    )[0];
  const parse_name = (new_name + new_artist).replace(/[^A-Za-z]/g, "");
  // console.log(name + artist);
  // console.log(parse_name);
  return parse_name;
}

// TODO: unwrap content of that function in loop
async function filterTracks(offset) {
  console.log("started " + offset);
  let count = 0;
  const tracks = new Map();
  const promise = await new Promise((resolve, _reject) => {
    db.each(
      `SELECT track_id, synced_lyrics FROM lyrics LIMIT ${offset}, ${PROCESS_STEP}`,
      (err, row) => {
        if (err) throw err;

        count++;
        if (count % 100000 === 0) {
          console.log(`${count} filtered, ${tracks.size} found`);
        }

        const track = tracks.get(row.track_id);
        if (row.synced_lyrics && (!track || track.tries < MAX_TRIES)) {
          const result = calculateWPM(row.synced_lyrics);

          if (result) {
            tracks.set(row.track_id, {
              tries: MAX_TRIES + 1,
              result,
            });
          } else {
            tracks.set(row.track_id, {
              tries: ((track && track.tries) || 0) + 1,
            });
          }
        }
      },
      (err, totalRows) => {
        if (err) throw err;
        const data = [];

        console.log(`\n${totalRows} lyrics processed`);

        db.each(
          `SELECT id, name, artist_name FROM tracks`,
          (err, tr) => {
            if (err) {
              console.error("Error executing query:", err.message);
              return;
            }
            const track = tracks.get(tr.id);
            if (track && track.tries === MAX_TRIES + 1) {
              data.push({
                name: tr.name,
                artist: tr.artist_name,
                result: tracks.get(tr.id).result,
              });
            }
          },
          (err, _totalRows) => {
            if (err) throw err;
            console.log(`${data.length} results after filters`);

            // filter duplicates
            const filtered_data = data.reduce((acc, x) => {
              const key = parseName(x.name, x.artist);
              if (!acc.seen.has(key)) {
                acc.seen.add(key);
                acc.result.push(x);
              }
              // else {
              //   console.log("duplicate");
              // }
              return acc;
            }, { seen: new Set(), result: [] }).result;

            let writeToFile = "";
            filtered_data.forEach((entry) => {
              const res = entry.result;
              writeToFile +=
                `${res.average} WPM ${res.repeats} rp ${entry.artist} - ${entry.name} Peaks: ${
                  res.top5.map((w) => w.toFixed(2)).join(", ")
                }\n`;
            });

            try {
              fs.appendFileSync(FINAL_NAME, writeToFile);
              console.log("File has been written successfully.");
            } catch (err) {
              console.error("Error writing to file:", err);
            }
            console.log("resolving " + offset);
            resolve();
          },
        );
      },
    );
  });
  return promise;
}

// Open the database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
  }
});

fs.writeFileSync(FINAL_NAME, "");

db.all("SELECT COUNT(*) as gg FROM lyrics", (_err, rows) => {
  console.log(rows[0].gg, "lyrics total");
  const rows_count = rows[0].gg;
  loop(rows_count);
});
async function loop(rows_count) {
  for (let i = 0; i < rows_count; i += PROCESS_STEP) {
    await filterTracks(i);
    console.log("finish " + i);
  }
  db.close();
  //optional
  try {
    const content = fs.readFileSync(FINAL_NAME, "utf8");
    content.split("\n").sort().join("\n");
    fs.writeFileSync(FINAL_NAME, content);
  } catch (err) {
    console.error("(js string is too long?) Error writing to file:", err);
  }
}
