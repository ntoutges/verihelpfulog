# Verilog Compilation/Simulation Helper
This CLI tool is used to help develop verilog.\
This relies on Icarus Verilog both being installed and setup properly in the path.

## Usage
1. Put the vlg folder somewhere it won't be moved. This is important for the next step.
2. Run `npm install`. Note that this requires `npm` to be installed on your system.
3. Run the verilog.js program, as `node verilog.js` (or with whichever node interpreter you prefer). This will generate a makefile, which can be used in all subsequent projects.

## Command Explanations
* `build`
  * Compile the project (this injects special code into the compiled project, so `iverilog` cannot be substituted)
* `run`
  * Simulate the project, saving the results to a file within `temp/sim/runs/`
* `serve`
  * Serve the local webpage used to view the results of the simulation.
* `all`
  * build + run + serve
* `open`
  * Open the local webpage (localhost) used to view the results of the simulation in your default browser.
* `allo` (all/open)
  * build + run + serve + open

## Special Comments
To log data from a module in your verilog program, simply add in the following comment above the module to track:
```
// @<name>(<vars_to_track>);
```

`name` is how the contents will be tracked. This should be unique across multiple modules. One module should have a `name` of `main`.\
`vars_to_track` is a comma-separated list of values to track (monitor).
* Each entry can be in the following format: `<var_name>[<start_index>:<end_index>]: <type>`
  * `var_name`: The name of the var/net to track
  * `start_index`: The index within the var/net to track (optional)
  * `end_index`: The index within the var/net to track up to (optional)
  * `type`: How to print the data. This can be one of the following
    * bool/bit/binary: %b
    * int/integer: %d
    * float/number: %f
    * hex: %H