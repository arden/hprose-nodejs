/**********************************************************\
|                                                          |
|                          hprose                          |
|                                                          |
| Official WebSite: http://www.hprose.com/                 |
|                   http://www.hprose.org/                 |
|                                                          |
\**********************************************************/

/**********************************************************\
 *                                                        *
 * hprose/client/HttpClient.js                            *
 *                                                        *
 * Hprose Http Client for Node.js.                        *
 *                                                        *
 * LastModified: May 20, 2015                             *
 * Author: Ma Bingyao <andot@hprose.com>                  *
 *                                                        *
\**********************************************************/

/*jshint node:true, eqeqeq:true */
'use strict';

var util = require('util');
var http = require('http');
var https = require('https');
var parse = require('url').parse;

var Exception = global.hprose.Exception;
var Client = global.hprose.Client;
var BytesIO = global.hprose.BytesIO;
var Completer = global.hprose.Completer;

var s_cookieManager = {};

function setCookie(headers, host) {
    var name, value, cookies, cookie, i;
    for (name in headers) {
        name = name.toLowerCase();
        value = headers[name];
        if ((name === 'set-cookie') || (name === 'set-cookie2')) {
            cookies = value.replace(/(^\s*)|(\s*$)/g, '').split(';');
            cookie = {};
            value = cookies[0].replace(/(^\s*)|(\s*$)/g, '').split('=', 2);
            if (value[1] === undefined) value[1] = null;
            cookie.name = value[0];
            cookie.value = value[1];
            for (i = 1; i < cookies.length; i++) {
                value = cookies[i].replace(/(^\s*)|(\s*$)/g, '').split('=', 2);
                if (value[1] === undefined) value[1] = null;
                cookie[value[0].toUpperCase()] = value[1];
            }
            // Tomcat can return SetCookie2 with path wrapped in "
            if (cookie.PATH) {
                if (cookie.PATH.charAt(0) === '"') {
                    cookie.PATH = cookie.PATH.substr(1);
                }
                if (cookie.PATH.charAt(cookie.PATH.length - 1) === '"') {
                    cookie.PATH = cookie.PATH.substr(0, cookie.PATH.length - 1);
                }
            }
            else {
                cookie.PATH = '/';
            }
            if (cookie.EXPIRES) {
                cookie.EXPIRES = Date.parse(cookie.EXPIRES);
            }
            if (cookie.DOMAIN) {
                cookie.DOMAIN = cookie.DOMAIN.toLowerCase();
            }
            else {
                cookie.DOMAIN = host;
            }
            cookie.SECURE = (cookie.SECURE !== undefined);
            if (s_cookieManager[cookie.DOMAIN] === undefined) {
                s_cookieManager[cookie.DOMAIN] = {};
            }
            s_cookieManager[cookie.DOMAIN][cookie.name] = cookie;
        }
    }
}

function getCookie(host, path, secure) {
    var cookies = [];
    for (var domain in s_cookieManager) {
        if (host.indexOf(domain) > -1) {
            var names = [];
            for (var name in s_cookieManager[domain]) {
                var cookie = s_cookieManager[domain][name];
                if (cookie.EXPIRES && ((new Date()).getTime() > cookie.EXPIRES)) {
                    names.push(name);
                }
                else if (path.indexOf(cookie.PATH) === 0) {
                    if (((secure && cookie.SECURE) ||
                         !cookie.SECURE) && (cookie.value !== null)) {
                        cookies.push(cookie.name + '=' + cookie.value);
                    }
                }
            }
            for (var i in names) {
                delete s_cookieManager[domain][names[i]];
            }
        }
    }
    if (cookies.length > 0) {
        return cookies.join('; ');
    }
    return '';
}

function HttpClient(uri, functions) {
    if (this.constructor !== HttpClient) {
        return new HttpClient(uri, functions);
    }
    Client.call(this, uri, functions);
    var _header = Object.create(null);

    var self = this;
    function sendAndReceive(request) {
        if (!Buffer.isBuffer(request)) {
            request = new Buffer(request);
        }
        var completer = new Completer();
        var options = parse(self.uri);
        var protocol = options.protocol;
        var client;
        var secure;
        if (protocol === 'http:') {
            client = http;
            secure = false;
        }
        else if (protocol === 'https:') {
            client = https;
            secure = true;
        }
        else {
            throw new Exception('Unsupported ' + protocol + ' protocol!');
        }
        options.keepAlive = self.keepAlive;
        for (var key in self.options) {
            options[key] = self.options[key];
        }
        options.method = 'POST';
        options.headers = Object.create(null);
        for (var name in _header) {
            options.headers[name] = _header[name];
        }
        options.headers['Content-Length'] = request.length;
        var cookie = getCookie(options.host, options.path, secure);
        if (cookie !== '') {
            options.headers.Cookie = cookie;
        }
        var timeoutId;
        var req = client.request(options, function(resp) {
            var bytes = new BytesIO();
            resp.on('data', bytes.write);
            resp.on('end', function() {
                if (timeoutId !== undefined) {
                    global.clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                if (resp.statusCode === 200) {
                    completer.complete(bytes.bytes);
                }
                else {
                    completer.completeError(new Exception(
                        resp.statusCode + ':' + bytes.toString()));
                }
            });
            resp.on('error', function(e) {
                if (timeoutId !== undefined) {
                    global.clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                completer.completeError(e);
            });
            resp.on('aborted', function() {
                if (timeoutId !== undefined) {
                    global.clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
            });
            if (resp.statusCode === 200) {
                setCookie(resp.headers, options.host);
            }
        });
        if (self.timeout > 0) {
            timeoutId = global.setTimeout(function() {
                req.removeAllListeners('error');
                req.abort();
                completer.completeError(new Exception('timeout'));
            }, self.timeout);
        }

        req.on('error', function(e) {
            if (timeoutId !== undefined) {
                global.clearTimeout(timeoutId);
                timeoutId = undefined;
            }
            completer.completeError(e);
        });
        req.end(request);
        return completer.future;
    }

    function setHeader(name, value) {
        if (name.toLowerCase() !== 'content-type' &&
            name.toLowerCase() !== 'content-length' &&
            name.toLowerCase() !== 'host') {
            if (value) {
                _header[name] = value;
            }
            else {
                delete _header[name];
            }
        }
    }

    Object.defineProperties(this, {
        setHeader: { value: setHeader },
        sendAndReceive: { value: sendAndReceive }
    });
}

function create(uri, functions) {
    var protocol = parse(uri).protocol;
    if (protocol === 'http:' ||
        protocol === 'https:') {
        return new HttpClient(uri, functions);
    }
    throw new Exception('This client desn\'t support ' + protocol + ' scheme.');
}

Object.defineProperty(HttpClient, 'create', { value: create });

util.inherits(HttpClient, Client);

global.hprose.HttpClient = HttpClient;
