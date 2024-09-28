const fs = require("node:fs");
const path = require("node:path");
const { spawn, exec } = require("node:child_process");

const cwd = process.cwd();
const ext = new Set([ "v" ]);

const types = {
    "bool": "%b",
    "bit": "%b",
    "binary": "%b",
    "%b": "%b",

    "int": "%d",
    "integer": "%d",
    "%d": "%d",
    
    "float": "%f",
    "number": "%f",
    "%f": "%f",

    "hex": "%H",
    "%h": "%H"
};

// Ensure temp/ folder exists
if (!fs.existsSync(path.join(cwd, "temp")) || !fs.statSync(path.join(cwd, "temp")).isDirectory()) {
    fs.mkdirSync(path.join(cwd, "temp"));
}

// Augment pre-placed $display and $monitor to allow output to be displayed
function injectOutputCommands(text) {
    
    // Start output command with @::ost::_, and end with @::oen::_ => (O)utput (ST)art, and (O)utput (EN)d
    return text.replace(/((?:\$display)|(?:\$monitor))\("(.*?[^\\])"(.*)\)/g, "$1(\"@::ost::_ \\n$2\\n@::oen::_ \\n\"$3);");
}

function getFileTokens(data) {
    const tokens = [];
    for (const match of data.matchAll(/^\/\/ @(.*?)\((.*?)\);$(?:\n+)module (.*)?\(.*;(?:\n+)([ \t]*)/gm)) {
        const start = match.index;
        const end = data.indexOf("endmodule", start);
        
        tokens.push({
            start,
            end,
            name: match[1],
            vars: match[2].split(",").map(arg => arg.trim()),
            mod: match[3],
            indent: match[4]
        });
    }

    // Sort in end-descending order
    return tokens.sort((a, b) => b.end - a.end);
}

function getTrackedVars(token, vars) {
    const trackedVars = [];
    for (const arg of token.vars) {
        if (arg == "*" || arg == "") continue; // Ignore wildcard for matching

        const parts = arg.match(/^(.+?)(?:\[(.+?)(?::(.+?))?\])?(?::\W*(.*))?$/);
        
        let err = null;
        if (!parts) err = `Invalid signifier "${arg}" for module ${token.mod}\nShould be in the format <name>([<index>(:<toIndex>)?])?(: <as-type>)?`;
        else if (!parts[1]) err = `Invalid signifier "${arg}": No variable name given\nShould be in the format <name>([<index>(:<toIndex>)?])?(: <as-type>)?`;
        else if (parts[2] && (!isFinite(parts[2]) || parseInt(+parts[2]) != +parts[2] || +parts[2] < 0)) err = `Invalid signifier "${arg}": Invalid index given; Must be non-negative finite integer\nShould be in the format <name>([<index>(:<toIndex>)?])?(: <as-type>)?`;
        else if (parts[3] && (!isFinite(parts[3]) || parseInt(+parts[3]) != +parts[3] || parts[3] < 0 +parts[3] > +parts[2])) err = `Invalid signifier "${arg}": Invalid toIndex given; Must be non-negative finite integer less than index\nShould be in the format <name>([<index>(:<toIndex>)?])?(: <as-type>)?`;
        else if (parts[4] && !types.hasOwnProperty(parts[4].toLowerCase())) err = `Invalid signifier "${arg}": Invalid type "${parts[4]}". Must be one of the following: [ ${Object.keys(types).join(" ")} ]`;
        if (err != null) {
            console.log(err);
            reject();
            return;
        }

        const name = parts[1];
        let index = parts[2];
        let toIndex = parts[3];
        const type = parts[4] ? types[parts[4].toLowerCase()] : "%b"

        if (!vars.hasOwnProperty(name)) {
            console.log(`Invalid watch variable "${name}" specified in ${arg} for module ${token.mod}`);
            reject();
            return;
        }
        const vToken = vars[name];

        // Validate index
        if (index != null) {
            index = +index; // Garunteed valid due to previous checks

            // Indexing into non-vector variable
            let err = null;
            if (index != 0 && !vToken.field) // Assume [0] index implies only available value to print
                err = `Variable "${name}" is not a vector; Cannot access index ${index} from it!`;
            if (index > vToken.field.max || index < vToken.field.min)
                err = `Index out of bounds; Index for variable "${name}" must be in range [${vToken.field.min}, ${vToken.field.max}). ${index} is too ${index < vToken.field.min ? "low" : "high"}!`;

            if (err != null) {
                console.log(err);
                reject();
                return;
            }
        }

        if (toIndex != null) {
            toIndex = +toIndex; // Garunteed valid due to previous checks

            // Indexing into non-vector variable
            let err = null;
            if (toIndex != 0 && !vToken.field) // Assume [0] index implies only available value to print
                err = `Variable "${name}" is not a vector; Cannot access toIndex ${toIndex} from it!`;
            if (toIndex > vToken.field.max || toIndex < vToken.field.min)
                err = `toIndex out of bounds; toIndex for variable "${name}" must be in range [${vToken.field.min}, ${vToken.field.max}). ${index} is too ${index < vToken.field.min ? "low" : "high"}!`;

            if (err != null) {
                console.log(err);
                reject();
                return;
            }
        }

        if (vToken.field) {
            if (index == null)        trackedVars.push({ name,                                 type });
            else if (toIndex == null) trackedVars.push({ name: `${name}[${index}]`,            type });
            else                      trackedVars.push({ name: `${name}[${index}:${toIndex}]`, type });
        }
        else                          trackedVars.push({ name,                                 type });
    }
    if (token.vars.includes("*")) {
        for (const name in vars) {
            trackedVars.push({ name, type: "%b" });
        }
    }

    return trackedVars;
}

function cleanBuildDir() {
    const promises = [];
    const files = fs.readdirSync(path.join(cwd, "temp/build"));

    for (const file of files) {
        promises.push(
            new Promise((resolve) => {
                fs.unlink(path.join(cwd, "temp/build", file), (err) => { resolve(); });
            })
        );
    }

    return Promise.all(promises);
}

const files = fs.readdirSync(cwd);
const vFiles = [];
function fileTr() {
    if (!fs.existsSync(path.join(cwd, "temp/build")) || !fs.statSync(path.join(cwd, "temp/build")).isDirectory()) {
        fs.mkdirSync(path.join(cwd, "temp/build"));
    }

    const promises = [];

    for (const file of files) {
        if (file.indexOf(".") == -1 || !ext.has(file.substring(file.indexOf(".") + 1))) continue;
        vFiles.push(file);
        
        promises.push(
            new Promise((resolve, reject) => {
                const filename = file;
                fs.readFile(path.join(cwd, filename), { encoding: "utf8" }, (err, data) => {
                    if (err) {
                        console.log(`Error reading file ${filename}.`);
                        reject();
                        return;
                    }
                    
                    data = data.replace(/\r/g, ""); // Get rid of the worst character
                    data = injectOutputCommands(data); // Inject special characters into display commands
                    
                    const tokens = getFileTokens(data);

                    for (const token of tokens) {
                        const vars = getVars(data.substring(token.start, token.end))
                        const trackedVars = getTrackedVars(token, vars)

                        const { display, monitor } = trackedVars.length ? buildMonitor(token.name, trackedVars) : { display: "", monitor: "" };
                        const interrupt = token.name == "main" ? buildInterrupt(token.name, 100) : "";
                        const tracker = buildTracker(token.name, 1);

                        data = data.substring(0, token.end) + insert(`// BEGIN < Injected Code >\ninitial begin\n${token.indent}${display}\n${token.indent}${monitor}\nend\n${interrupt}\n${tracker}`, token.indent) + data.substring(token.end);
                    }

                    fs.writeFile(path.join(cwd, "temp/build", filename), data, {}, () => {
                        resolve();
                    });
                });
            })
        );
    }

    return Promise.all(promises);
}

function insert(data, indent) {
    return `\n${data.split("\n").map(line => indent + line).join("\n")}\n`;
}

function getVars(module) {
    let vars = {};

    const types = new Set(["wire", "reg", "time", "realtime", "real", "integer"]);

    for (let line of module.split("\n")) {
        line = line.replace(/^ */g, "");

        // Get rid of input/output prefixes
        if (line.startsWith("input ") || line.startsWith("output ")) line = line.substring(line.indexOf(" "));

        let type = line.substring(0, line.indexOf(" "));
        if (!types.has(type)) continue;
        line = line.substring(line.indexOf(" ") + 1);

        // Vector?
        let field = "";
        if (line[0] == "[") {
            field = line.substring(1, line.indexOf("]"));
            line = line.substring(line.indexOf("]") + 1);
        }

        line.substring(0, line.indexOf(";")).replace(/ /g, "").split(",").forEach(name => {
            vars[name] = { type };

            if (field) {
                const start = +field.split(":")[0];
                const end = +field.split(":")[1];
                vars[name].field = {
                    start,
                    end,
                    min: Math.min(start, end),
                    max: Math.max(start, end)
                };
            }
        });
    }

    return vars;
}

function buildMonitor(module, variables) {
    return {
        display: `$display("@::mod::${module} ${variables.map(token => token.name + `[${token.type.replace("%", "")}]`).join(" <@@> ")}");`,
        monitor: `$monitor("@::mon::${module} ${variables.map(token => token.type).join(" <@@> ")}", ${variables.map(token => token.name).join(", ")});`
    };
}

// Allows node program to take control
function buildInterrupt(module, interval) {
    return `always #${interval} begin
    $display("@::int::${module} ${interval}");
    $stop;
end`
}

function buildTracker(module, interval) {
    return `always #${interval} $display("@::trk::${module} %0d", $time);`;
}

const out = "vlg.out"
function compile() {
    const outfile = "\"" + path.join(cwd, out).replace(/"/g, "\\\"") + "\"";
    const paths = vFiles.map(filename => "\"" + path.join(cwd, "temp/build", filename).replace(/"/g, "\\\"") + "\"");

    return new Promise((resolve, reject) => {
        exec(`powershell /c iverilog -o ${outfile} ${paths.join(" ")}`, (err, stdout, stderr) => {
            if (err) {
                reject(err);
                return;
            }
            if (stdout || stderr) {
                reject(stdout || stderr);
                return;
            }
            resolve(stdout);
        })
    });
}
async function processCompile() { console.log("Transpiling...");
    if (!fs.existsSync(path.join(cwd, "temp/build")) || !fs.statSync(path.join(cwd, "temp/build")).isDirectory()) {
        fs.mkdirSync(path.join(cwd, "temp/build"));
    }

    try {
        await cleanBuildDir();
    }
    catch(err) {
        console.log("Failed to clean build directory");
        reject(err);
        return;
    }

    try { await fileTr(); }
    catch(err) {
        console.log("Failed to transpile.");
        reject(err);
        return;
    }
    console.log("Compiling...");

    try { await compile(); }
    catch(err) {
        console.log("Failed to compile");
        console.log(err);
        reject(err);
        return;
    }

    console.log(`Successfully compiled into ${out}`);
}

async function processVVPLine(vvp, line, state) {
    if (!line.startsWith("@::")) {
        if (state.freeOutput) {
            console.log(">", line);
            state.output.push(`${state.time}:${line}`);
        }
        return; // Not special line
    }
    
    const parts = line.match(/^@::(.+?)::(.+?) (.*)$/);
    
    if (!parts) return; // Invalid line
    
    const type = parts[1];
    const module = parts[2];
    const arg = parts[3];

    if (!state.out.hasOwnProperty(module)) state.out[module] = [];

    switch (type) {
        case "mod": // Monitor Display
            console.log(arg)
            state.out[module].push(["@time", ...arg.split(" <@@> ")]);
            break;
            case "mon": // Monitor
            state.out[module].push([state.time.toString(), ...arg.split(" <@@> ")]);
            break;
        case "trk":
            state.time++;
            break;
        case "int": // Interrupt

            state.itt++;
            if (state.itt == state.simData.maxItt) {
                await state.onInterrupt(state, true);
                vvp.stdin.write("$finish\n");
                break;
            }

            await state.onInterrupt(state);
            vvp.stdin.write("cont\n");

            break;
        case "ost": // Output Start
            state.freeOutput = true;
            break;
        case "oen": // Output end
            state.freeOutput = false;
            break;
    }
}

function saveRunData(state, force = false) {
    if (
        !force && 
        (new Date()).getTime() < state.lastUpdate + state.simData.maxSaveTimeMS                 // Not long enough time
        && Object.values(state.out).every(data => data.length < state.simData.maxSaveDataLen)   // Data not long enough
        && state.output.length < state.simData.maxSaveDataLen                                   // Output data not long enough
    ) return;
    
    const delimiter = ",";
    
    // Save run data
    const promises = [];
    for (const module in state.out) {
        if (state.out[module].length == 0) continue;
        promises.push(
            new Promise((resolve) => {
                let rows = state.out[module].map(row => row.map(entry => (entry.includes(delimiter) ? "\"" + entry.replace(/\"/g, "\"\"") + "\"" : entry.replace(/\"/g, "\"\""))).join(delimiter)).join("\n");
                if (rows) rows += "\n";
                
                const pth = path.join(cwd, "/temp/sim/runs", `run-${state.simData.lastRun}`, `${module}.csv`);
                fs.writeFile(pth, rows, { flag: "a" }, (err) => { resolve(); })
            })
        );
        state.out[module].splice(0); // Clear out array
    }
    
    promises.push(
        new Promise((resolve) => {
            const pth = path.join(cwd, "/temp/sim/runs", `run-${state.simData.lastRun}`, "_out.log");
            fs.writeFile(pth, state.output.join("\n"), { flag: "a" }, (err) => { resolve(); });
            state.output.splice(0); // Clear output array
        })
    );
    
    return Promise.all(promises);
}

function run(onInterrupt, simData) {
    const outfile = path.join(cwd, out).replace(/\"/g, "\\\"");
    const vvp = spawn("vvp", [outfile]);
    children.push(vvp);

    let state = {
        out: {},
        onInterrupt,
        simData,
        lastUpdate: (new Date()).getTime(),
        itt: 0,
        time: 0,
        freeOutput: false,
        output: []
    };
    
    let line = "";
    vvp.stdout.on("data", (out) => {
        const lines = out.toString().replace(/\r/g, "").split("\n");
        lines[0] = line + lines[0];
        
        for (const line of lines.slice(0, -1)) processVVPLine(vvp, line, state);
        line = lines[lines.length - 1];
    });

    return new Promise((resolve) => {
        vvp.on("close", () => {
            resolve();
        });
    });
}

const children = [];
async function processRun() {
    if (!fs.existsSync(path.join(cwd, out)) || !fs.statSync(path.join(cwd, out)).isFile()) {
        console.log(`Unable to find file ${out}. Try running with the flag -c to compile.`);
        return;
    }

    if (!fs.existsSync(path.join(cwd, "temp/sim")) || !fs.statSync(path.join(cwd, "temp/sim")).isDirectory()) {
        fs.mkdirSync(path.join(cwd, "temp/sim"));
    }

    if (!fs.existsSync(path.join(cwd, "temp/sim/runs")) || !fs.statSync(path.join(cwd, "temp/sim/runs")).isDirectory()) {
        fs.mkdirSync(path.join(cwd, "temp/sim/runs"));
    }

    let simData = {
        maxSaveTimeMS: 100,
        maxSaveDataLen: 1000,
        maxItt: 10
    };
    let lastRun = 0;
    if (!fs.existsSync(path.join(cwd, "temp/sim/run.json")) || !fs.statSync(path.join(cwd, "temp/sim/run.json")).isFile()) {
        fs.writeFileSync(path.join(cwd, "temp/sim/run.json"), JSON.stringify(simData, null, 4));
    }
    else {
        simData = JSON.parse(fs.readFileSync(path.join(cwd, "temp/sim/run.json"), { encoding: "utf-8" }));
    }

    if (!fs.existsSync(path.join(cwd, "temp/sim/lr.txt")) || !fs.statSync(path.join(cwd, "temp/sim/lr.txt")).isFile()) {
        fs.writeFileSync(path.join(cwd, "temp/sim/lr.txt"), lastRun.toString());
    }
    else {
        lastRun = +fs.readFileSync(path.join(cwd, "temp/sim/lr.txt"), { encoding: "utf-8" });
        if (!isFinite(lastRun) || lastRun < 0) lastRun = 0;
        else lastRun++;
        fs.writeFileSync(path.join(cwd, "temp/sim/lr.txt"), lastRun.toString());
    }

    if (!fs.existsSync(path.join(cwd, "temp/sim/runs", `run-${lastRun}`)) || !fs.statSync(path.join(cwd, "temp/sim/runs", `run-${lastRun}`)).isDirectory()) {
        fs.mkdirSync(path.join(cwd, "temp/sim/runs", `run-${lastRun}`));
    }

    console.log("Running...");
    await run(saveRunData, { ...simData, lastRun });
}

async function processServe(doOpen) {
    const express = require("express");
    const app = express();

    app.use(express.static(path.join(cwd, "temp/sim/runs")));
    
    app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "index.html"));
    });

    app.get("/runs", (req, res) => {
        if (!req.query?.r) {
            res.send(JSON.stringify(fs.readdirSync(path.join(cwd, "temp/sim/runs"))));
            return;
        }
        
        try {
            res.send(JSON.stringify(fs.readdirSync(path.join(cwd, "temp/sim/runs", req.query.r))));
        }
        catch(err) { res.send("[]"); }
    });
    
    const listener = app.listen(3001, async () => {
        const port = listener.address().port;
        console.log(`App listening on port ${port}`);
    
        if (doOpen) {
            console.log(`Opening site at localhost:${port}`);
            const { openApp } = await import("open");
            await openApp(`http://localhost:${port}`);
        }
    });
}

function buildMakeFile() {
    const content = `# Copy this file into your workspace

ROOT_DIR = ${__dirname}
PRG = ${path.relative(__dirname, __filename)}
NODE = ${process.argv0}

# Compile, run, then serve
all:
	$(NODE) $(ROOT_DIR)${path.sep}$(PRG) -a

# Compile, run, serve, then open
allo:
	$(NODE) $(ROOT_DIR)${path.sep}$(PRG) -ao

# Compile
build:
	$(NODE) $(ROOT_DIR)${path.sep}$(PRG) -c

# Run (simulate)
run:
	$(NODE) $(ROOT_DIR)${path.sep}$(PRG) -r

# Serve (allow to open at localhost:3001)
serve:
	$(NODE) $(ROOT_DIR)${path.sep}$(PRG) -s

# Serve, then open (in default browser)
open:
	$(NODE) $(ROOT_DIR)${path.sep}$(PRG) -so
`;

    // Create makefile in current directory
    fs.writeFileSync(path.join(cwd, "makefile"), content);
}


// Flag "a" will run (a)ll
// Flag "ao" will run (a)ll/(o)pen
const flags = new Set(process.argv.slice(2).filter(f => f.startsWith("-")).map(f => f.substring(1)));
async function main() {
    if (flags.size == 0 || flags.has("m")) buildMakeFile();         // Create make file (default behaviour)

    if (flags.has("a") || flags.has("c")) await processCompile();   // (c)ompile
    if (flags.has("a") || flags.has("r")) await processRun();       // (r)un
    if (flags.has("a") || flags.has("ao") || flags.has("s") || flags.has("so")) await processServe(flags.has("so") || flags.has("ao")); // (s)erve or (s)erve/(o)pen page
}

main();

let killed = false;
["exit", 'SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, () => {
        if (killed) return;
        killed = true;

        children.forEach(child => child.kill("SIGINT"));
        process.exit();
    });
});