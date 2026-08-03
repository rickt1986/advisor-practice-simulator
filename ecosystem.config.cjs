const fs = require("node:fs");

function readEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

module.exports = {
  apps: [{
    name: "advisor-practice-simulator",
    script: "server.js",
    cwd: "/srv/advisor-practice-simulator/current",
    env: {
      ...readEnvFile("/etc/advisor-practice-simulator.env"),
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "3101",
      MAX_REQUESTS_PER_WINDOW: "30"
    }
  }]
};
