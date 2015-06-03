var WebSocket = require('ws');
var Protocol = require('pomelo-protocol');
var Package = Protocol.Package;
var Message = Protocol.Message;
var EventEmitter = require('events').EventEmitter;
var protobuf = require('pomelo-protobuf');
var util = require('util');
var JS_WS_CLIENT_TYPE = 'js-websocket';
var JS_WS_CLIENT_VERSION = '0.0.1';

var heartbeatInterval_const = 5000
var nextHeartbeatTimeout_const = 0;
var gapThreshold_const = 100; // heartbeat gap threshold
var RES_OK = 200;
var RES_OLD_CLIENT = 501;



var pomelo = function(){
	this.socket = null;
	this.reqId = 0;
	this.callbacks = {};
	this.handlers = {};
	this.routeMap = {};
	this.heartbeatInterval = heartbeatInterval_const;
 	this.heartbeatTimeout = heartbeatInterval_const * 2;
 	this.nextHeartbeatTimeout = nextHeartbeatTimeout_const;
 	this.gapThreshold = gapThreshold_const; // heartbeat gap threshold
 	this.heartbeatId = null;
 	this.heartbeatTimeoutId = null;
 	this.handshakeCallback = null;
  initPomleo(this)
 	this.handshakeBuffer = {
  	'sys':{
    	type: JS_WS_CLIENT_TYPE,
    	version: JS_WS_CLIENT_VERSION
  	},
  	'user':{
  	}
	};
}

util.inherits(pomelo,EventEmitter);
pomelo.prototype.init = function(params, cb){
  this.params = params;
  params.debug = true;
  this.initCallback = cb;
  var host = params.host;
  var port = params.port;

  var url = 'ws://' + host;
  if(port) {
    url +=  ':' + port;
  }


  if (!params.type) {
    this.handshakeBuffer.user = params.user;
    this.handshakeCallback = params.handshakeCallback;
    this.initWebSocket(url,cb);
  }
};




pomelo.prototype.onData = function(self,data){
  //probuff decode
  var msg = Message.decode(data);

  if(msg.id > 0){
    msg.route = self.routeMap[msg.id];
    delete self.routeMap[msg.id];
    if(!msg.route){
      return;
    }
  }
  msg.body = deCompose(self,msg);
  processMessage(self, msg);
};

var processMessage = function(pomelo, msg) {
  if(!msg || !msg.id) {
    // server push message
    // console.error('processMessage error!!!');
    pomelo.emit(msg.route, msg.body);
    return;
  }

  //if have a id then find the callback function with the request
  var cb = pomelo.callbacks[msg.id];

  delete pomelo.callbacks[msg.id];
  if(typeof cb !== 'function') {
    return;
  }

  cb(msg.body);
  return;
};

var deCompose = function(pomelo,msg){
  var protos = !!pomelo.data.protos ? pomelo.data.protos.server : {};
  var abbrs = pomelo.data.abbrs;
  var route = msg.route;

  try {
    //Decompose route from dict
    if(msg.compressRoute) {
      if(!abbrs[route]){
        return {};
      }

      route = msg.route = abbrs[route];
    }
    if(!!protos[route]){
      return protobuf.decode(route, msg.body);
    }else{
      return JSON.parse(Protocol.strdecode(msg.body));
    }
  } catch(ex) {
    console.error(ex.stack)
  }

  return msg;
};

pomelo.prototype.onKick = function(sefl,data) {
  this.emit('onKick');
};

pomelo.prototype.handshake = function(self,data){

  data = JSON.parse(Protocol.strdecode(data));
  if(data.code === RES_OLD_CLIENT) {
    self.emit('error', 'client version not fullfill');
    return;
  }

  if(data.code !== RES_OK) {
    self.emit('error', 'handshake fail');
    return;
  }
  //self.handshakeInit(data);
  if(data.sys && data.sys.heartbeat) {
    self.heartbeatInterval = data.sys.heartbeat * 1000;   // heartbeat interval
    self.heartbeatTimeout = self.heartbeatInterval * 2;        // max heartbeat timeout
  } else {
    self.heartbeatInterval = 0;
    self.heartbeatTimeout = 0;
  }

 // self.initData(data);

 if(!data || !data.sys) {
    return;
  }
  self.data = self.data || {};
  var dict = data.sys.dict;
  var protos = data.sys.protos;

  //Init compress dict
  if(!!dict){
    self.data.dict = dict;
    self.data.abbrs = {};

    for(var route in dict){
      self.data.abbrs[dict[route]] = route;
    }
  }

  //Init protobuf protos
  if(!!protos){
    self.data.protos = {
      server : protos.server || {},
      client : protos.client || {}
    };
    if(!!protobuf){
      protobuf.init({encoderProtos: protos.client, decoderProtos: protos.server});
    }
  }
 //
  if(typeof self.handshakeCallback === 'function') {

    self.handshakeCallback(data.user);
  }
  
  //

  var obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
  send(self,obj);
 

  if(self.initCallback) {
    self.initCallback(self,self.socket);
    self.initCallback = null;
  }
};


pomelo.prototype.processPackage = function(msg){
  var msg1 = new Buffer(msg.toString(),'base64')

  
  this.handlers[msg.type](this,msg.body);
};



pomelo.prototype.initWebSocket = function(url,cb){
  var self = this;
  var onopen = function(event){

    var obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(self.handshakeBuffer)));
    send(self,obj);
  };
  var onmessage = function(event) {

    self.processPackage(Package.decode(event.data), cb);
    // new package arrived, update the heartbeat timeout
    if(self.heartbeatTimeout) {
      self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout;
    }
  };
  var onerror = function(event) {

    self.emit('io-error', event);
  };
  var onclose = function(event){

    self.emit('close',event);
  };
  this.socket = new WebSocket(url);
  this.socket.binaryType = 'arraybuffer';
  this.socket.onopen = onopen;
  this.socket.onmessage = onmessage;
  this.socket.onerror = onerror;
  this.socket.onclose = onclose;
};



pomelo.prototype.request = function(route, msg, cb) {
  msg = msg || {};
  route = route || msg.route;
  if(!route) {
    return;
  }

  this.reqId++;
  var self = this;
  sendMessage(self,self.reqId, route, msg);

  this.callbacks[this.reqId] = cb;
  this.routeMap[this.reqId] = route;
};

var sendMessage = function(self,reqId, route, msg) {
  var type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;

  //compress message by protobuf
  var protos = !!self.data.protos?self.data.protos.client:{};
  if(!!protos[route]){
    msg = protobuf.encode(route, msg);
  }else{
    msg = Protocol.strencode(JSON.stringify(msg));
  }

  var compressRoute = 0;
  if(self.dict && self.dict[route]){
    route = self.dict[route];
    compressRoute = 1;
  }

  msg = Message.encode(reqId, type, compressRoute, route, msg);
  var packet = Package.encode(Package.TYPE_DATA, msg);
  send(self,packet);
};
pomelo.prototype.notify = function(route, msg) {
  msg = msg || {};
  sendMessage(this,0, route, msg);
};



pomelo.prototype.disconnect = function() {
  if(this.socket) {
    if(this.socket.disconnect) this.socket.disconnect();
    if(this.socket.close) this.socket.close();
    this.socket = null;
  }
  var self =  this
  if(this.heartbeatId) {
    clearTimeout(self.heartbeatId);
    this.heartbeatId = null;
  }
  if(this.heartbeatTimeoutId) {
    clearTimeout(self.heartbeatTimeoutId);
    this.heartbeatTimeoutId = null;
  }
};


pomelo.prototype.heartbeat = function(self,data) {

  var obj = Package.encode(Package.TYPE_HEARTBEAT);
  if(self.heartbeatTimeoutId) {
    clearTimeout(self.heartbeatTimeoutId);
    self.heartbeatTimeoutId = null;
  }

  if(self.heartbeatId) {
    // already in a heartbeat interval
    return;
  }

  self.heartbeatId = setTimeout(function() {
    self.heartbeatId = null;
    send(self,obj);

    self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout;
    self.heartbeatTimeoutId = setTimeout(self.heartbeatTimeoutCb, self.heartbeatTimeout);
  }, self.heartbeatInterval);
};

pomelo.prototype.heartbeatTimeoutCb = function() {
	var self = this;
  var gap = self.nextHeartbeatTimeout - Date.now();
  if(gap > self.gapThreshold) {
    self.heartbeatTimeoutId = setTimeout(self.heartbeatTimeoutCb, gap);
  } else {
    self.emit('heartbeat timeout');
    self.disconnect();
  }
};

var send = function(self,packet){
  if (!!self.socket) {
    self.socket.send(packet.buffer || packet, {binary: true, mask: true});
  }
};


var initPomleo = function(self){

  self.handlers[Package.TYPE_HANDSHAKE] = self.handshake;
  self.handlers[Package.TYPE_HEARTBEAT] = self.heartbeat;
  self.handlers[Package.TYPE_DATA] = self.onData;
  self.handlers[Package.TYPE_KICK] = self.onKick;

}





module.exports= pomelo