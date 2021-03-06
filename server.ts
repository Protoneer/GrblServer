//#!tsc --target ES5 --module commonjs server.ts && node server.js

///<reference path="./typings/bundle.d.ts"/>
///<reference path="./typings/serialport.d.ts" />
///<reference path="./typings/config.d.ts" />
///<reference path="./typings/node-static.d.ts" />

import * as websocket from 'websocket';
import {
	Grbl,
	STATE_IDLE,
	GrblLineParserResultStartup,
	GrblLineParserResultOk,
	GrblLineParserResultError,
	GrblLineParserResultAlarm,
	GrblLineParserResultFeedback,
	GrblLineParserResultDollar,
	GrblLineParserResultStatus,
} from './grbl';
import http = require('http');
import serialport = require("serialport");
import config = require("config");
import static = require("node-static");

interface GrblServerConfig {
	serialPort: string;
	serialBaud: number;
	serverPort: number;
};

interface JSONRPCRequest {
	method: string;
	params: any;
	id: number;
}

interface JSONRPCResponse {
	result?: any;
	error?: JSONRPCError;
	id: number;
}

interface JSONRPCError {
	code: number;
	message?: string;
	data?: any;
}

const JSONRPCErrorParseError = <JSONRPCError>{
	code: -32700,
	message: 'Parse Error'
};
const JSONRPCErrorInvalidRequest = <JSONRPCError>{
	code: -32600,
	message: 'Invalid Request'
};
const JSONRPCErrorMethodNotFound = <JSONRPCError>{
	code: -32601,
	message: 'Method not found'
};
const JSONRPCErrorInvalidParams = <JSONRPCError>{
	code: -32602,
	message: 'Invalid params'
};
const JSONRPCErrorInternalError = <JSONRPCError>{
	code: -32603,
	message: 'Internal error'
};

class JSONRPCErrorServerError implements JSONRPCError {
	code: number; /* -32000 to -32099 */
	message: string;
	data: any;
	constructor(code: number, message: string, data: any) {
		this.code = code;
		this.message = message;
		this.data = data;
	}
}

class JSONRPCErrorGrblError extends JSONRPCErrorServerError {
	constructor(data: any) {
		super(-32000, "Error on grbl", data);
	}
}

class JSONRPCErrorNotIdleError extends JSONRPCErrorServerError {
	constructor(data: any) {
		super(-32001, "Grbl state is not idle", data);
	}
}


class GCode {
	name : string;
	sent : Array<string>
	remain: Array<string>
	total: number;
	createdTime: number;
	startedTime : number;
	constructor(name: string, gcode: string) {
		this.name   = name;
		this.sent   = [];
		this.remain = gcode.split(/\n/);
		this.total  = this.remain.length;
		this.createdTime = new Date().getTime();
	}
}

class GrblServer {
	httpServer : http.Server;
	wsServer : websocket.server;
	sessions : Array<websocket.connection>;
	grbl : Grbl;
	config: GrblServerConfig;

	canceling: boolean;
	gcode: GCode;

	start() {
		this.loadConfig();
		this.startHttp();
		this.startWebSocket();
		this.openSerialPort();
	}

	loadConfig() {
		this.config = <GrblServerConfig>{
			serverPort: config.get('serverPort'),
			serialPort: config.get('serialPort'),
			serialBaud: config.get('serialBaud'),
		};
		console.log('Launching with this config: ');
		console.log(this.config);
	}

	startHttp() {
		var fileServer = new static.Server('./browser');

		console.log('startHttp');
		this.httpServer = http.createServer( (req, res) => {
			if (req.url === '/config') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(this.config));
			} else {
				fileServer.serve(req, res);
			}
		});

		this.httpServer.listen(this.config.serverPort, () => {
			console.log('Server is listening on port ' + this.config.serverPort);
		});
	}

	startWebSocket() {
		console.log('startWebSocket');
		this.sessions = [];

		this.wsServer = new websocket.server({
			httpServer: this.httpServer,
			maxReceivedFrameSize: 131072,
			maxReceivedMessageSize: 10 * 1024 * 1024,
			autoAcceptConnections: false
		});

		this.wsServer.on('request', (req) => {
			if (!req.remoteAddress.match(/^((::ffff:)?(127\.|10\.|192\.168\.)|::1)/)) {
				req.reject();
				console.log('Connection from origin ' + req.remoteAddress + ' rejected.');
				return;
			}

			var connection: websocket.connection;
			try {
				connection = req.accept(null, req.origin);
			} catch (e) {
				console.log(e);
				return;
			}
			console.log('Connection accepted. from:' + req.remoteAddress + ' origin:' + req.origin);

			this.sessions.push(connection);

			this.sendInitialMessage(connection);

			connection.on('message', (message) => {
				console.log(message);
				try {
					if (message.type !== 'utf8') return;
					console.log('Req: ' + message.utf8Data);
					var req: JSONRPCRequest;
					try {
						req = JSON.parse(message.utf8Data);
					} catch (e) {
						this.sendMessage(connection, {
							id: null,
							error: JSONRPCErrorParseError,
						});
					}

					console.log('request ', req.method);

					var method: (params: any)=>Promise<any> = (<any>this)['service_' + req.method];
					if (!method) {
						this.sendMessage(connection, {
							id: req.id,
							error: JSONRPCErrorMethodNotFound,
						});
					}

					method.call(this, req.params || {}).
						then( (result: any) => {
							this.sendMessage(connection, {
								id: req.id,
								result: result || null
							});
						}, (error: JSONRPCErrorServerError) => {
							this.sendMessage(connection, {
								id: req.id,
								error: error || null
							});
						});
				} catch (e) {
					this.sendMessage(connection, {
						id: null,
						error: JSONRPCErrorInternalError,
					});
				}
			});

			connection.on('frame', (frame: websocket.frame) => {
				console.log(frame);
			});

			connection.on('error', (e) => {
				console.log(e);
			});

			connection.on('close', (reasonCode, description) => {
				console.log('Peer ' + connection.remoteAddress + ' disconnected.', reasonCode, description);
				this.sessions.splice(this.sessions.indexOf(connection), 1);
				console.log(this.sessions);
			});
		});
	}

	sendInitialMessage(connection: websocket.connection) {
		this.sendMessage(connection, {
			id: null,
			result: {
				type: 'init',
				lastAlarm: this.grbl.lastAlarm ? this.grbl.lastAlarm.message : null,
				lastFeedback: this.grbl.lastFeedback ? this.grbl.lastFeedback.message : null,
				status: this.grbl.status,
			}
		});

		if (this.gcode) {
			this.sendMessage(connection, {
				id: null,
				result: {
					type: 'gcode',
					gcode: this.gcode,
				}
			});
		}
	}

	sendMessage(connection: websocket.connection, response: JSONRPCResponse) {
		connection.sendUTF(JSON.stringify(response));
	}

	sendBroadcastMessage(message: any) {
		for (let i = 0, it: websocket.connection; it = this.sessions[i]; i++) {
			this.sendMessage(it, message);
		}
	}

	service_upload(params: any): Promise<any> {
		return new Promise( (resolve, reject) => {
//			if (this.grbl.status.state !== STATE_IDLE) {
//				reject(new JSONRPCErrorNotIdleError(this.grbl.status.state));
//				return;
//			}

			// load new gcode
			this.gcode = new GCode(params.name, params.gcode);

			console.log('New gcode uploaded: ', this.gcode.remain.length, 'lines');

			this.sendBroadcastMessage({
				id: null,
				result: {
					type: 'gcode',
					gcode: this.gcode,
				}
			});

			resolve();
		});
	}

	service_gcode(params: any): Promise<any> {
		return new Promise( (resolve, reject) => {
			if (params.execute) {
				this.gcode.startedTime = new Date().getTime();
				this.sendOneLine();
				this.sendBroadcastMessage({
					id: null,
					result: {
						type: 'gcode.start',
						time: this.gcode.startedTime,
					}
				});
				resolve();
			} else
			if (params.clear) {
				this.gcode = null;
				this.sendBroadcastMessage({
					id: null,
					result: {
						type: 'gcode',
						gcode: this.gcode,
					}
				});
			} else {
				resolve({
					type: 'gcode',
					gcode: this.gcode,
				});
			}
		});
	}

	service_config(params: any): Promise<any> {
		return new Promise( (resolve, reject) => {
			this.grbl.getConfig().
				then(resolve, reject);
		});
	}

	service_command(params: any): Promise<any> {
		if (params.command === '$$') {
			return this.grbl.getConfig();
		} else {
			return this.grbl.command(params.command);
		}
	}

	service_reset(params: any): Promise<any> {
		return new Promise( (resolve, reject) => {
			this.grbl.reset();
			resolve();
		});
	}

	service_resume(params: any): Promise<any> {
		return new Promise( (resolve, reject) => {
			this.grbl.realtimeCommand('~');
			resolve();
		});
	}

	service_pause(params: any): Promise<any> {
		return new Promise( (resolve, reject) => {
			this.grbl.realtimeCommand('!');
			resolve();
		});
	}

	openSerialPort() {
		console.log('openSerialPort');
		var sp = new serialport.SerialPort(this.config.serialPort, {
			baudrate: this.config.serialBaud,
			parser: serialport.parsers.readline("\n")
		}, false);

		this.grbl = new Grbl(sp);
		this.grbl.open();

		this.grbl.on('startup', (res: GrblLineParserResultStartup) => {
			this.initializeGrbl();
			this.sendBroadcastMessage({
				id: null,
				result: res.toObject({
					type: 'startup',
				}),
			});
			this.sendBroadcastMessage({
				id: null,
				result: {
					type: 'gcode',
					gcode: null,
				}
			});
		});

		this.grbl.on('statuschange', (status: GrblLineParserResultStatus) => {
			console.log('statuschange');
			this.sendBroadcastMessage({
				id: null,
				result: {
					type: 'status',
					status: status
				}
			});
		});

		this.grbl.on('alarm', (res: GrblLineParserResultAlarm) => {
			this.sendBroadcastMessage({
				id: null,
				result: res.toObject({
					type: 'alarm',
				}),
			});
		});

		this.grbl.on('feedback', (res: GrblLineParserResultFeedback) => {
			this.sendBroadcastMessage({
				id: null,
				result: res.toObject({
					type: 'feedback',
				}),
			});
		});

		this.grbl.on('error', (e: GrblLineParserResultError) => {
			console.log('Error on grbl: ' + e);
			this.sendBroadcastMessage({
				id: null,
				error: new JSONRPCErrorGrblError(e.message),
			});
			setTimeout( () => {
				this.openSerialPort();
			}, 5000);
		});
	}

	destory() {
		this.grbl.close();
	}

	initializeGrbl() {
		this.gcode = null;
		this.grbl.getConfig().
			then( (res) => {
				console.log(res);
			}, (e) => {
			});
	}

	sendOneLine() {
		if (this.canceling) {
			this.canceling = false;
			return;
		}

		if (!this.gcode.remain.length) {
			// done
			this.sendBroadcastMessage({
				id: null,
				result: {
					type: 'gcode.done'
				}
			});
			return;
		}
		var code = this.gcode.remain.shift();
		this.gcode.sent.push(code);
		this.sendBroadcastMessage({
			id: null,
			result: {
				type: 'gcode.progress',
				gcode: code,
			}
		});
		this.grbl.command(code).
			then( () => {
				this.sendOneLine();
			}, (e) => {
				this.sendOneLine();
				console.log('Error on sending gcode:' + e);
				this.sendBroadcastMessage({
					id: null,
					error: new JSONRPCErrorGrblError(e.message),
				});
			});
	}
}

new GrblServer().start();


