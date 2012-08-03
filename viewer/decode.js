/******************************************************************************/
/* decode.js -- The pcap decoding functions
 *
 */
/*jshint
  node: true, plusplus: false, curly: true, eqeqeq: true, immed: true, latedef: true, newcap: true, nonew: true, undef: true, strict: true, trailing: true
*/
"use strict";

//////////////////////////////////////////////////////////////////////////////////
//// Decode pcap buffers and build up simple objects
//////////////////////////////////////////////////////////////////////////////////

var internals = {};

exports.inet_ntoa = function(num) {
  return (num >> 24 & 0xff) + '.' + (num>>16 & 0xff) + '.' + (num>>8 & 0xff) + '.' + (num & 0xff);
};


exports.icmp = function (buffer, obj) {
  obj.icmp = {
    length:    buffer.length,
    type:      buffer[0],
    code:      buffer[1],
    sum:       buffer.readUInt16BE(2),
    id:        buffer.readUInt16BE(4),
    sequence:  buffer.readUInt16BE(6)
  };

  obj.udp.data = buffer.slice(8);
};

exports.tcp = function (buffer, obj) {
  obj.tcp = {
    length:     buffer.length,
    sport:      buffer.readUInt16BE(0),
    dport:      buffer.readUInt16BE(2),
    seq:        buffer.readUInt32BE(4),
    ack:        buffer.readUInt32BE(8),
    off:        ((buffer[12] >> 4) & 0xf),
    res1:       (buffer[12] & 0xf),
    flags:      buffer[13],
    res2:       (buffer[13] >> 6 & 0x3),
    urgflag:    (buffer[13] >> 5 & 0x1),
    ackflag:    (buffer[13] >> 4 & 0x1),
    pshflag:    (buffer[13] >> 3 & 0x1),
    rstflag:    (buffer[13] >> 2 & 0x1),
    synflag:    (buffer[13] >> 1 & 0x1),
    finflag:    (buffer[13] >> 0 & 0x1),
    win:        buffer.readUInt16BE(14),
    sum:        buffer.readUInt16BE(16),
    urp:        buffer.readUInt16BE(18)
  };

  obj.tcp.data = buffer.slice(4*obj.tcp.off);
};

exports.udp = function (buffer, obj) {
  obj.udp = {
    length:     buffer.length,
    sport:      buffer.readUInt16BE(0),
    dport:      buffer.readUInt16BE(2),
    ulen:       buffer.readUInt16BE(4),
    sum:        buffer.readUInt16BE(6)
  };

  obj.udp.data = buffer.slice(8);
};

exports.ip4 = function (buffer, obj) {
  obj.ip = {
    length: buffer.length,
    hl:     (buffer[0] & 0xf),
    v:      ((buffer[0] >> 4) & 0xf),
    tos:    buffer[1],
    len:    buffer.readUInt16BE(2),
    id:     buffer.readUInt16BE(4),
    off:    buffer.readUInt16BE(6),
    ttl:    buffer[8],
    p:      buffer[9],
    sum:    buffer.readUInt16BE(10),
    addr1:  exports.inet_ntoa(buffer.readUInt32BE(12)),
    addr2:  exports.inet_ntoa(buffer.readUInt32BE(16))
  };

  switch(obj.ip.p) {
  case 1:
    exports.icmp(buffer.slice(obj.ip.hl*4, obj.ip.len), obj);
    break;
  case 6:
    exports.tcp(buffer.slice(obj.ip.hl*4, obj.ip.len), obj);
    break;
  case 17:
    exports.udp(buffer.slice(obj.ip.hl*4, obj.ip.len), obj);
    break;
  default:
    console.log("Unknown ip.p", obj);
  }
};

exports.ip6 = function (buffer, obj) {
  obj.ip = {
    length: buffer.length,
    v:      ((buffer[0] >> 4) & 0xf),
    tc:     ((buffer[0] & 0xf) << 4) | ((buffer[1] >> 4) & 0xf),
    flow:   ((buffer[1] & 0xf) << 16) | (buffer[2] << 8) | buffer[3],
    len:    buffer.readUInt16BE(4),
    nextHeader: buffer[6],
    hopLimt:  buffer[7]
  };
};

exports.ether = function (buffer, obj) {
  obj.ether = {
    length: buffer.length,
    addr1:  buffer.slice(0, 6).toString('hex', 0, 6),
    addr2:  buffer.slice(6, 12).toString('hex', 0, 6),
    type:   buffer.readUInt16BE(12)
  };

  switch(obj.ether.type) {
  case 0x0800:
    exports.ip4(buffer.slice(14), obj);
    break;
  case 0x86dd:
    exports.ip6(buffer.slice(14), obj);
    break;
  default:
    console.log("Unknown ether.type", obj);
    break;
  }
};


exports.pcap = function (buffer, obj) {
  obj.pcap = {
    ts_sec:   buffer.readUInt32LE(0),
    ts_usec:  buffer.readUInt32LE(4),
    incl_len: buffer.readUInt32LE(8),
    orig_len: buffer.readUInt32LE(12)
  };

  exports.ether(buffer.slice(16, obj.pcap.incl_len + 16), obj);
};

exports.reassemble_udp = function (packets, cb) {
  var results = [];
  packets.forEach(function (item) {
    var key = item.ip.addr1 + ':' + item.udp.sport;
    if (results.length === 0 || key !== results[results.length-1].key) {
      var result = {
        key: key,
        data: item.udp.data
      };
      results.push(result);
    } else {
      var newBuf = new Buffer(results[results.length-1].data.length + item.udp.data.length);
      results[results.length-1].data.copy(newBuf);
      item.udp.data.copy(newBuf, results[results.length-1].data.length);
      results[results.length-1].data = newBuf;
    }
  });
  cb(null, results);
};

exports.reassemble_tcp = function (packets, cb) {

  // Sort Packets
  var clientKey = packets[0].ip.addr1 + ':' + packets[0].tcp.sport;
  packets.sort(function(a,b) {

    if (a.tcp.rstflag) {
      return -1;
    }

    if (b.tcp.rstflag) {
      return -1;
    }

    if ((a.ip.addr1 === b.ip.addr1) && (a.tcp.sport === b.tcp.sport)) {
      return (a.tcp.seq - b.tcp.seq);
    }

    if (clientKey === a.ip.addr1 + ':' + a.tcp.sport) {
      return ((a.tcp.seq + a.tcp.data.length-1) - b.tcp.ack);
    }

    return (a.tcp.ack - (b.tcp.seq + b.tcp.data.length-1) );
  });

  // Now divide up conversation, removing dups
  var clientSeq = 0;
  var hostSeq = 0;

  var results = [];
  packets.forEach(function (item) {
    var key = item.ip.addr1 + ':' + item.tcp.sport;
    if (key === clientKey) {
      if (clientSeq >= (item.tcp.seq + item.tcp.data.length)) {
        return;
      }
      clientSeq = (item.tcp.seq + item.tcp.data.length);
    } else {
      if (hostSeq >= (item.tcp.seq + item.tcp.data.length)) {
        return;
      }
      hostSeq = (item.tcp.seq + item.tcp.data.length);
    }

    if (results.length === 0 || key !== results[results.length-1].key) {
      var result = {
        key: key,
        data: item.tcp.data
      };
      results.push(result);
    } else {
      var newBuf = new Buffer(results[results.length-1].data.length + item.tcp.data.length);
      results[results.length-1].data.copy(newBuf);
      item.tcp.data.copy(newBuf, results[results.length-1].data.length);
      results[results.length-1].data = newBuf;
    }
  });

  cb(null, results);
};