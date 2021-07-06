// Control module for Yamaha Pro Audio, using SCP communication
// Jack Longden <Jack@atov.co.uk> 2019
// updated by Andrew Broughton <andy@checkcheckonetwo.com>
// Apr 13, 2020 Version 1.4.1 

var tcp 		= require('../../tcp');
var instance_skel 	= require('../../instance_skel');
var scpNames 		= require('./rcpNames.json');
var upgradeScripts	= require('./upgrade');

const RCP_PARAMS 	= ['Ok', 'Command', 'Index', 'Address', 'X', 'Y', 'Min', 'Max', 'Default', 'Unit', 'Type', 'UI', 'RW', 'Scale'];
const RCP_VALS 		= ['Status', 'Command', 'Address', 'X', 'Y', 'Val', 'TxtVal'];


// Instance Setup
class instance extends instance_skel {
	
	constructor(system, id, config) {
		super(system, id, config);

		this.rcpCommands   = [];
		this.nameCommands  = []; 	// Commands which have a name field
		this.colorCommands = [];	// Commands which have a color field
		this.rcpPresets    = [];
		this.productName   = '';
		this.macroRec      = false;
		this.macroCount    = 0;
		this.dataStore     = {};

	}

	static GetUpgradeScripts() {
		return upgradeScripts
	}

	// Startup
	init() {
		this.updateConfig(this.config);
	}


	// Module deletion
	destroy() {
	
		if (this.socket !== undefined) {
			this.socket.destroy();
		}

		this.log('debug', `destroyed ${this.id}`);
	}


	// Web config fields
	config_fields() {
		
		let fields = [
			{
				type: 		'textinput',
				id: 		'host',
				label: 		'IP Address of Console',
				width: 		6,
				default: 	'192.168.0.128',
				regex: 		this.REGEX_IP
			},
			{
				type: 		'dropdown',
				id: 		'model',
				label: 		'Console Type',
				width: 		6,
				default: 	'CL/QL',
				choices: [
					{id: 'CL/QL', label: 'CL/QL Console'},
					{id: 'TF', label: 'TF Console'}
				]
			}
		]
		for(let i = 1; i <= 4; i++){
			fields.push({
				type: 		'textinput',
				id: 		`myChName${i}`,
				label: 		`My Channel #${i} Name`,
				width: 		6,
				default: 	`My Channel ${i}`,
			},
			{
				type: 		'number',
				id: 		`myCh${i}`,
				label: 		`Channel #${i}`,
				width:		2,
				min: 		1,
				max: 		72,
				default: 	1,
				required: 	false
			})
		}
		return fields;
	}

	
	// Change in Configuration
	updateConfig(config) {
		
		let fname = '';
		const FS  = require("fs");
		
		this.config = config;
		
		if (this.config.model == 'CL/QL') {
			fname = 'CL5 RCP Parameters-1.txt';
		}
		else {
			fname = 'TF5 RCP Parameters-1.txt';
		}

		// Read the DataFile
		let data = FS.readFileSync(`${__dirname}/${fname}`);
		this.rcpCommands = this.parseData(data, RCP_PARAMS);

		this.rcpCommands.sort((a, b) => {
			let acmd = a.Address.slice(a.Address.indexOf("/") + 1);
			let bcmd = b.Address.slice(b.Address.indexOf("/") + 1);
			return acmd.toLowerCase().localeCompare(bcmd.toLowerCase());
		})

		for (let i = 0; i < 4; i++) {
			rcpNames.chNames[i] = {id: `-${i+1}`, label: this.config[`myChName${(i+1)}`]};
		}
		
		this.newConsole();
	}


	// Whenever the console type changes, update the info
	newConsole() {
		
		this.log('info', `Device model= ${this.config.model}`);
		
		this.actions(); // Re-do the actions once the console is chosen
		this.presets();
		this.init_tcp();
	}


	// Make each command line into an object that can be used to create the commands
	parseData(data, params) {
		
		let cmds    = [];
		let line    = [];
		const lines = data.toString().split("\x0A");
		
		for (let i = 0; i < lines.length; i++){
			// I'm not going to even try to explain this next line,
			// but it basically pulls out the space-separated values, except for spaces those that are inside quotes!
			line = lines[i].match(/(?:[^\s"]+|"[^"]*")+/g)
			if (line !== null && (['OK','NOTIFY'].indexOf(line[0].toUpperCase()) !== -1)) {
				let rcpCommand = {};
				
				for (var j = 0; j < line.length; j++){
					rcpCommand[params[j]] = line[j].replace(/"/g,'');  // Get rid of any double quotes around the strings
				}
				if (['GET','SSCURRENT_EX'].indexOf(line[1].toUpperCase()) === -1) {
					cmds.push(rcpCommand); // Ignore the GET confirmations...
				}

				if (params === RCP_PARAMS) {
					let cmdArr = undefined;
					switch(rcpCommand.Address.slice(-4)) {
						case 'Name':
							cmdArr = this.nameCommands;
							break;
						case 'olor':
							cmdArr = this.colorCommands;
					}
					if (cmdArr !== undefined) cmdArr.push('scp_' + rcpCommand.Index);
				}
			}		
		}
		return cmds
	}


	// Get info from a connected console
	getConsoleInfo() {
		this.socket.send(`devinfo productname\n`);
	}


	// Initialize TCP
	init_tcp() {
		
		let receivebuffer  = '';
		let receivedLines  = [];
		let receivedcmds   = [];
		let foundCmd	   = {};
		
		if (this.socket !== undefined) {
			this.socket.destroy();
			delete this.socket;
		}

		if (this.config.host) {
			this.socket = new tcp(this.config.host, 49280);

			this.socket.on('status_change', (status, message) => {
				this.status(status, message);
			});

			this.socket.on('error', (err) => {
				this.status(this.STATUS_ERROR, err);
				this.log('error', `Network error: ${err.message}`);
			});

			this.socket.on('connect', () => {
				this.status(this.STATUS_OK);
				this.log('info', `Connected!`);
				this.getConsoleInfo();
				this.pollScp();
			});

			this.socket.on('data', (chunk) => {
				receivebuffer += chunk;
				
				receivedLines = receivebuffer.split("\x0A");	// Split by line break


				for(let line of receivedLines){
					if (line.length == 0) {
						continue;
					} 

					this.log('debug', `Received from device: '${line}'`);

					if (line.indexOf('OK devinfo productname') !== -1) {
					
						this.productName = line.slice(receivebuffer.lastIndexOf(" "));
						this.log('info', `Device found: ${this.productName}`);
					
					} else {
					
						receivedcmds = this.parseData(line, RCP_VALS); // Break out the parameters
						
						for (let i=0; i < receivedcmds.length; i++) {
							foundCmd = this.rcpCommands.find(cmd => cmd.Address == receivedcmds[i].Address.slice(0,cmd.Address.length)); // Find which command

							if (foundCmd !== undefined) {
									this.addToDataStore({scp: foundCmd, cmd: receivedcmds[i]})
									this.addMacro({scp: foundCmd, cmd: receivedcmds[i]});
									this.checkFeedbacks();							
							} else {
							
								this.log('debug', `Unknown command received: '${receivedcmds[i].Address}'`);
							
							}
						}
					}
				}				
				
				receivebuffer = '';	// Clear the buffer
			
			});
		}
	}



	// Create single Action/Feedback
	createAction(rcpCmd) {
		
		let newAction = {};
		let valParams = {};
		let rcpLabel  = '';

		if (this.config.model == 'TF' && scpCmd.Type == 'scene') {
			scpLabel = 'Scene/Bank'
		} else {
			scpLabel = rcpCmd.Address.slice(rcpCmd.Address.indexOf("/") + 1); // String after "MIXER:Current/"
		}
		
		// Add the commands from the data file. Action id's (action.action) are the SCP command number
		let rcpLabels = rcpLabel.split("/");
		let rcpLabelIdx = (rcpLabel.startsWith("Cue")) ? 1 : 0;
		
		newAction = {label: rcpLabel, options: []};
		if (rcpCmd.X > 1) {
			if (rcpLabel.startsWith("InCh") || rcpLabel.startsWith("Cue/InCh")) {
				newAction.options = [
					{type: 'dropdown', label: rcpLabels[scpLabelIdx], id: 'X', default: 1, minChoicesForSearch: 0, choices: rcpNames.chNames}
				]
			} else {
				newAction.options = [
					{type: 'number', label: rcpLabels[scpLabelIdx], id: 'X', min: 1, max: rcpCmd.X, default: 1, required: true, range: false}
				]
			}
			rcpLabelIdx++;
		}

		if (rcpCmd.Y > 1) {
			if (this.config.model == "TF" && rcpCmd.Type == 'scene') {
				valParams = {type: 'dropdown', label: rcpLabels[rcpLabelIdx], id: 'Y', default: 'a', choices:[
					{id: 'a', label: 'A'},
					{id: 'b', label: 'B'}
				]}
			} else {
				valParams = {type: 'number', label: rcpLabels[scpLabelIdx], id: 'Y', min: 1, max: rcpCmd.Y, default: 1, required: true, range: false}
			}

			newAction.options.push(valParams);
		}
		
		if (rcpLabelIdx < rcpLabels.length - 1) {
			rcpLabelIdx++;
		}

		switch(rcpCmd.Type) {
			case 'integer':
				if (rcpCmd.Max == 1) {
					valParams = {type: 'checkbox', label: 'On', id: 'Val', default: (rcpCmd.Default == 1) ? true : false}
				} else {
					valParams = {
						type: 'number', label: rcpLabels[scpLabelIdx], id: 'Val', min: rcpCmd.Min, max: rcpCmd.Max, default: parseInt(rcpCmd.Default), required: true, range: false
					}
				}
				break;
			case 'string':
			case 'binary':
				if (rcpLabel.startsWith("CustomFaderBank")) {
					valParams = {type: 'dropdown', label: rcpLabels[rcpLabelIdx], id: 'Val', default: rcpCmd.Default, minChoicesForSearch: 0, choices: rcpNames.customChNames}
				} else if (rcpLabel.endsWith("Color")) {
					valParams = {type: 'dropdown', label: rcpLabels[scpLabelIdx], id: 'Val', default: rcpCmd.Default, minChoicesForSearch: 0, 
					choices: this.config.model == "TF" ? rcpNames.chColorsTF : rcpNames.chColors}
				} else if (rcpLabel.endsWith("Icon")) {
					valParams = {type: 'dropdown', label: rcpLabels[scpLabelIdx], id: 'Val', default: rcpCmd.Default, minChoicesForSearch: 0, 
					choices: rcpNames.chIcons}
				} else if (rcpLabel == "DanteOutPort/Patch") {
					valParams = {type: 'dropdown', label: rcpLabels[scpLabelIdx], id: 'Val', default: rcpCmd.Default, minChoicesForSearch: 0, 
					choices: scpNames.danteOutPatch}
				} else if (rcpLabel == "OmniOutPort/Patch") {
					valParams = {type: 'dropdown', label: rcpLabels[scpLabelIdx], id: 'Val', default: rcpCmd.Default, minChoicesForSearch: 0, 
					choices: rcpNames.omniOutPatch}

				} else {
					valParams = {type: 'textinput', label: rcpLabels[rcpLabelIdx], id: 'Val', default: rcpCmd.Default, regex: ''}
				}
				break;
			default:
				return newAction;
		}
			
		newAction.options.push(valParams);
		return newAction;
		
	}

	
	// Create the Actions & Feedbacks
	actions(system) {
		
		let commands  = {};
		let feedbacks = {};
		let command   = {};
		let rcpAction = '';

		for (let i = 0; i < this.rcpCommands.length; i++) {
			command = this.rcpCommands[i]
			rcpAction = 'scp_' + command.Index;
		
			commands[rcpAction] = this.createAction(command);
			feedbacks[rcpAction] = JSON.parse(JSON.stringify(commands[rcpAction])); // Clone the Action to a matching feedback

			if (this.nameCommands.includes(rcpAction) || this.colorCommands.includes(rcpAction)) {
				feedbacks[rcpAction].options.pop();
			} else {
				feedbacks[rcpAction].options.push(
					{type: 'colorpicker', label: 'Color', id: 'fg', default: this.rgb(0,0,0)},
					{type: 'colorpicker', label: 'Background', id: 'bg', default: this.rgb(255,0,0)}
				)
			}
		}

		commands['macroRecStart'] = {label: 'Record RCP Macro'};
		commands['macroRecStop'] = {label: 'Stop Recording'};

		feedbacks['macroRecStart'] = {label: 'Macro is Recording', options: [
			{type: 'checkbox', label: 'ON', id: 'on', default: true},
			{type: 'colorpicker', label: 'Color', id: 'fg', default: this.rgb(0,0,0)},
			{type: 'colorpicker', label: 'Background', id: 'bg', default: this.rgb(255,0,0)}
		]};

/*
this.log('info','******** COMMAND LIST *********');
Object.entries(commands).forEach(([key, value]) => this.log('info',`<font face="courier">${value.label.padEnd(36, '\u00A0')} ${key}</font>`));
this.log('info','***** END OF COMMAND LIST *****')
*/

		this.setActions(commands);
		this.setFeedbackDefinitions(feedbacks);
	}

	
	// Create the proper command string for an action or poll
	parseCmd(prefix, rcpCmd, opt) {
		
		if (rcpCmd == undefined || opt == undefined) return;

		let scnPrefix  = '';
		let optX       = (opt.X === undefined) ? 1 : (opt.X > 0) ? opt.X : this.config[`myCh${-opt.X}`];
		let optY       = (opt.Y === undefined) ? 0 : opt.Y - 1;
		let optVal
		let rcpCommand = this.rcpCommands.find(cmd => 'scp_' + cmd.Index == scpCmd);
		if (rcpCommand == undefined) {
			this.log('debug',`PARSECMD: Unrecognized command. '${rcpCmd}'`)
			return;
		} 
		let cmdName = scpCommand.Address;			
		
		switch(rcpCommand.Type) {
			case 'integer':
			case 'binary':
				cmdName = `${prefix} ${cmdName}`
				optX--; 				// ch #'s are 1 higher than the parameter
				optVal = ((prefix == 'set') ? 0 + opt.Val : ''); 	// Changes true/false to 1 0
				break;
			
			case 'string':
				cmdName = `${prefix} ${cmdName}`
				optX--; 				// ch #'s are 1 higher than the parameter except with Custom Banks
				optVal = ((prefix == 'set') ? `"${opt.Val}"` : ''); // quotes around the string
				break;
	
			case 'scene':
				optY = '';
				optVal = '';
	
				if (prefix == 'set') {
					scnPrefix = 'ssrecall_ex';
					this.pollScp();		// so buttons with feedback reflect any changes
				} else {
					scnPrefix = 'sscurrent_ex';
					optX = '';
				}
	
				if (this.config.model == 'CL/QL') {
					cmdName = `${scnPrefix} ${cmdName}`;  		// Recall Scene for CL/QL
				} else {
					cmdName = `${scnPrefix} ${cmdName}${opt.Y}`; 	// Recall Scene for TF
				}
		}		
		
		return `${cmdName} ${optX} ${optY} ${optVal}`.trim(); 	// Command string to send to console
	}

	
	// Create the preset definitions
	presets() {
		this.rcpPresets = [{
			category: 'Macros',
			label: 'Create RCP Macro',
			bank: {
				style: 'text',
				text: 'Record RCP Macro',
				latch: true,
				size: 'auto',
				color: this.rgb(255,255,255),
				bgcolor: this.rgb(0,0,0)
			},
			actions: 		[{action: 'macroRecStart'}],
			release_actions: 	[{action: 'macroRecStop'}],
			feedbacks: 		[{type:   'macroRecStart', options: {on: true}}]
		}];
	
		this.setPresetDefinitions(this.rcpPresets);
	}

	
	// Add a command to a Macro Preset
	addMacro(c) {

		let foundActionIdx = -1;

		if (this.macroRec) {
			let cX = parseInt(c.cmd.X);
			let cY = parseInt(c.cmd.Y);
			let cV

			switch(c.rcp.Type) {
				case 'integer':
				case 'binary':
					cX++;
					cY++;
					if (c.rcp.Max == 1) {
						cV = ((c.cmd.Val == 0) ? false : true)
					} else {
						cV = parseInt(c.cmd.Val);
					}
					break;
				case 'string':
					cX++;
					cY++;
					cV = c.cmd.Val;
					break;
			}
			
			// Check for new value on existing action
			let rcpActions = this.rcpPresets[this.rcpPresets.length - 1].actions;
			if (rcpActions !== undefined) {
				foundActionIdx = rcpActions.findIndex(cmd => (
					cmd.action == 'rcp_' + c.rcp.Index && 
					cmd.options.X == cX &&
					cmd.options.Y == cY
				));
			}
			
			if (foundActionIdx == -1) {
				rcpActions.push([]);
				foundActionIdx = rcpActions.length - 1;
			}

			rcpActions[foundActionIdx] = {action: 'rcp_' + c.rcp.Index, options: {X: cX, Y: cY, Val: cV}};

		}
	}

	
	// Handle the Actions
	action(action) {

		if (!action.action.startsWith('macro')) {
			let cmd = this.parseCmd('set', action.action, action.options);
			if (cmd !== undefined) {
				this.log('debug', `sending '${cmd}' to ${this.config.host}`);

				if (this.socket !== undefined && this.socket.connected) {
					this.socket.send(`${cmd}\n`); 					// send it, but add a CR to the end
				}
				else {
					this.log('info', 'Socket not connected :(');
				}
			}	
		} else {
			if (action.action == 'macroRecStart' && this.macroRec == false) {
				this.macroCount++;
				this.rcpPresets.push({
					category: 'Macros',
					label: `Macro ${this.macroCount}`,
					bank: {
						style: 'text',
						text: `Macro ${this.macroCount}`,
						size: 'auto',
						color: this.rgb(255,255,255),
						bgcolor: this.rgb(0,0,0)
					},
					actions: []
				});
				this.macroRec = true;

			} else if (action.action == 'macroRecStop') {
				this.macroRec = false;
				if (this.rcpPresets[this.rcpPresets.length - 1].actions.length > 0) {
					this.setPresetDefinitions(this.rcpPresets);
				} else {
					this.rcpPresets.pop();
					this.macroCount = 0;
				}
			}
			this.checkFeedbacks('macroRecStart');
		}

	}
	

	// Handle the Feedbacks
	feedback(feedback, bank) {

		let options     = feedback.options;
		let rcpCommand  = this.rcpCommands.find(cmd => 'rcp_' + cmd.Index == feedback.type);
		let retOptions  = {};

		if (rcpCommand !== undefined) {
			let optVal = (options.Val == undefined ? options.X : (rcpCommand.Type == 'integer') ? 0 + options.Val : `${options.Val}`); 	// 0 + value turns true/false into 1 0
			let optX = (options.X > 0) ? options.X : this.config[`myCh${-options.X}`];
			let optY = (options.Y == undefined) ? 1 : options.Y;
						
			// console.log(`\nFeedback: '${feedback.id}' from bank '${bank.text}' is ${feedback.type} (${scpCommand.Address})`);
			// console.log(`X: ${optX}, Y: ${optY}, Val: ${optVal}`);

			if (this.dataStore[feedback.type] !== undefined && this.dataStore[feedback.type][optX] !== undefined) {
				
				retOptions = {text: bank.text, color: bank.color, bgcolor: bank.bgcolor};
				if (this.dataStore[feedback.type][optX][optY] == optVal) {
					
					retOptions = {text: (options.text == undefined) ? bank.text : options.text, color: options.fg, bgcolor: options.bg}
					// console.log(`  *** Match *** ${JSON.stringify(retOptions)}\n`);
					return retOptions;	

				} else {

					if (this.colorCommands.includes(feedback.type)) {
						let c = rcpNames.chColorRGB[this.dataStore[feedback.type][optX][optY]]
						retOptions.color   = c.color;
						retOptions.bgcolor = c.bgcolor;
						return retOptions;
					}
					if (this.nameCommands.includes(feedback.type)) {
						retOptions.text = this.dataStore[feedback.type][optX][optY];
						return retOptions;
					}
				}
			}

			return

		}
		
		if (feedback.type == 'macroRecStart' && options.on == this.macroRec) {
			return {color: options.fg, bgcolor: options.bg};
		}

		return;
	}


	// Poll the console for it's status to update buttons via feedback

	pollRcp() {
		let allFeedbacks = this.getAllFeedbacks();
		for (let fb in allFeedbacks) {
			let cmd = this.parseCmd('get', allFeedbacks[fb].type, allFeedbacks[fb].options);
			if (cmd !== undefined && this.id == allFeedbacks[fb].instance_id) {
				this.log('debug', `sending '${cmd}' to ${this.config.host}`);
				this.socket.send(`${cmd}\n`)
			}				
		}
	}


	addToDataStore(cmd) {
		let idx = cmd.rcp.Index;
		let iY;
		
		if (cmd.cmd.Val == undefined) {
			cmd.cmd.Val = parseInt(cmd.cmd.X);
			cmd.cmd.X = undefined;
		}
		
		cmd.cmd.X = (cmd.cmd.X == undefined) ? 0 : cmd.cmd.X;
		let iX = parseInt(cmd.cmd.X) + 1;
		
		if (this.config.model == 'TF' && idx == 1000) {
			iY = cmd.cmd.Address.slice(-1)
		} else {
			cmd.cmd.Y = (cmd.cmd.Y == undefined) ? 0 : cmd.cmd.Y;
			iY = parseInt(cmd.cmd.Y) + 1;
		}

		if (this.dataStore['rcp_' + idx] == undefined) {
			this.dataStore['rcp_' + idx] = {};
		}
		if (this.dataStore['rcp_' + idx][iX] == undefined) {
			this.dataStore['rcp_' + idx][iX] = {};
		}
		this.dataStore['rcp_' + idx][iX][iY] = cmd.cmd.Val;
	
	}


}

exports = module.exports = instance;
