import Orbit from 'orbit/core';
import Cache from 'orbit/cache';
import Document from 'orbit/document';
import Transformable from 'orbit/transformable';
import Requestable from 'orbit/requestable';
import MemoryStore from 'orbit/sources/memory_store';
import clone from 'orbit/lib/clone';

var RestStore = function(options) {
  Orbit.assert('RestStore requires Orbit.Promise be defined', Orbit.Promise);
  Orbit.assert('RestStore requires Orbit.ajax be defined', Orbit.ajax);

  options = options || {};
  this.remoteIdField = options['remoteIdField'] || 'id';
  this.namespace = options['namespace'];
  this.headers = options['headers'];

  this.idField = Orbit.idField;

  // Create an internal cache and expose some elements of its interface
  this._cache = new Cache(options.schema);
  Orbit.expose(this, this._cache, 'isDeleted', 'length', 'reset', 'retrieve');

  this._remoteIdMap = {};

  Transformable.extend(this);
  Requestable.extend(this, ['find', 'add', 'update', 'patch', 'remove', 'link', 'unlink']);
};

RestStore.prototype = {
  constructor: RestStore,

  /////////////////////////////////////////////////////////////////////////////
  // Transformable interface implementation
  /////////////////////////////////////////////////////////////////////////////

  _transform: function(operation) {
    var _this = this,
        path  = operation.path,
        data  = operation.value,
        type  = path[0],
        id    = path[1],
        remoteId,
        record;

    if (path.length > 2) {
      // PATCH

      remoteId = this._lookupRemoteId(type, id);
      if (!remoteId) throw new Orbit.NotFoundException(type, data);

      var baseURL = this._buildURL(type, remoteId);

      path = path.slice(2);

      if (path[0] === 'links') {
        var property = path[1];
        var linkDef = this._cache.schema.models[type].links[property];

        var linkedId;

        if (operation.op === 'remove') {
          if (path.length > 2) {
            linkedId = path.pop();
            path.push(this._lookupRemoteId(linkDef.model, linkedId));
          }

        } else {
          if (path.length > 2) {
            linkedId = path.pop();
            path.push('-');
          } else {
            linkedId = data;
          }
          data = this._lookupRemoteId(linkDef.model, linkedId);
        }
      }

      var remoteOp = {op: operation.op, path: baseURL + '/' + path.join('/')};
      if (data) remoteOp.value = data;

      return this._ajax(baseURL, 'PATCH', {data: remoteOp}).then(
        function() {
          _this._transformCache(operation);
        }
      );

    } else {
      if (operation.op === 'add') {
        // POST

        if (id) {
          var recordInCache = _this.retrieve([type, id]);
          if (recordInCache) {
            throw new Orbit.AlreadyExistsException(type, data);
          }
        }

        return this._ajax(this._buildURL(type), 'POST', {data: this._serialize(type, data)}).then(
          function(raw) {
            record = _this._deserialize(type, raw);
            record[_this.idField] = id;
            _this._addToCache(type, record);
          }
        );

      } else {
        remoteId = this._lookupRemoteId(type, data || id);
        if (!remoteId) throw new Orbit.NotFoundException(type, data);

        if (operation.op === 'replace') {
          // PUT

          return this._ajax(this._buildURL(type, remoteId), 'PUT', {data: this._serialize(type, data)}).then(
            function(raw) {
              record = _this._deserialize(type, raw);
              record[_this.idField] = id;
              _this._addToCache(type, record);
            }
          );

        } else if (operation.op === 'remove') {
          // DELETE

          return this._ajax(this._buildURL(type, remoteId), 'DELETE').then(function() {
            _this._transformCache(operation);

            // Track deleted records (Note: cache transforms won't be tracked)
            _this._cache.transform({op: 'add', path: ['deleted', type, id], value: true});
          });
        }
      }
    }
  },

  /////////////////////////////////////////////////////////////////////////////
  // Requestable interface implementation
  /////////////////////////////////////////////////////////////////////////////

  initRecord: function(type, record) {
    this._cache.initRecord(type, record);

    var id = record[this.idField],
        path = [type, id],
        remoteId = record[this.remoteIdField];

    if (remoteId) {
      if (!this.retrieve(path)) {
        this._transformCache({op: 'add', path: path, value: record});
      }
      this._updateRemoteIdMap(type, id, remoteId);
    }
  },

  _find: function(type, id) {
    if (id && (typeof id === 'number' || typeof id === 'string')) {
      var remoteId = this._lookupRemoteId(type, id);
      if (!remoteId) throw new Orbit.NotFoundException(type, id);
      return this._findOne(type, remoteId);

    } else if (id && (typeof id === 'object' && id[this.remoteIdField])) {
      return this._findOne(type, id[this.remoteIdField]);

    } else {
      return this._findQuery(type, id);
    }
  },

  _add: MemoryStore.prototype._add,
  _update: MemoryStore.prototype._update,
  _patch: MemoryStore.prototype._patch,
  _remove: MemoryStore.prototype._remove,
  _link: MemoryStore.prototype._link,
  _unlink: MemoryStore.prototype._unlink,

  /////////////////////////////////////////////////////////////////////////////
  // Internals
  /////////////////////////////////////////////////////////////////////////////

  _findOne: function(type, remoteId) {
    var _this = this;
    return this._ajax(this._buildURL(type, remoteId), 'GET').then(
      function(raw) {
        var record = _this._deserialize(type, raw);
        _this._recordFound(type, record);
        return record;
      }
    );
  },

  _findQuery: function(type, query) {
    var _this = this;

    return this._ajax(this._buildURL(type), 'GET', {data: query}).then(
      function(raw) {
        var eachRaw,
            record,
            records = [];

        raw.forEach(function(eachRaw) {
          record = _this._deserialize(type, eachRaw);
          _this._recordFound(type, record);
          records.push(record);
        });

        return records;
      }
    );
  },

  _recordFound: function(type, record) {
    var remoteId = record[this.remoteIdField],
        id = this._remoteToLocalId(type, remoteId),
        newRecord = (id === undefined);

    this._addToCache(type, record);
  },

  _remoteToLocalId: function(type, remoteId) {
    var dataForType = this._remoteIdMap[type];
    if (dataForType) return dataForType[remoteId];
  },

  _lookupRemoteId: function(type, data) {
    var remoteId;
    if (typeof data === 'object') {
      remoteId = data[this.remoteIdField];
    }
    if (!remoteId) {
      var record = this.retrieve([type, data]);
      if (record) {
        remoteId = record[this.remoteIdField];
      }
    }
    return remoteId;
  },

  _transformCache: function(operation) {
    if ((operation.op === 'remove' || operation.op === 'replace') &&
        !this.retrieve(operation.path)) {
      return;
    }

    var inverse = this._cache.transform(operation, true);
    this.didTransform(operation, inverse);
  },

  _addToCache: function(type, record) {
    var id = record[this.idField];
    if (id === undefined) {
      this._cache.initRecord(type, record);
      id = record[this.idField];
    }

    this._transformCache({op: 'add', path: [type, id], value: record});
    this._updateRemoteIdMap(type, id, record[this.remoteIdField]);
  },

  _updateRemoteIdMap: function(type, id, remoteId) {
    if (remoteId) {
      var mapForType = this._remoteIdMap[type];
      if (!mapForType) mapForType = this._remoteIdMap[type] = {};
      mapForType[remoteId] = id;
    }
  },

  _ajax: function(url, method, hash) {
    var _this = this;

    return new Orbit.Promise(function(resolve, reject) {
      hash = hash || {};
      hash.url = url;
      hash.type = method;
      hash.dataType = 'json';
      hash.context = _this;

//TODO-log      console.log('ajax start', method);

      if (hash.data && method !== 'GET') {
        hash.contentType = 'application/json; charset=utf-8';
        hash.data = JSON.stringify(hash.data);
      }

      if (_this.headers !== undefined) {
        var headers = _this.headers;
        hash.beforeSend = function (xhr) {
          for (var key in headers) {
            if (headers.hasOwnProperty(key)) {
              xhr.setRequestHeader(key, headers[key]);
            }
          }
        };
      }

      hash.success = function(json) {
//TODO-log        console.log('ajax success', method, json);
        resolve(json);
      };

      hash.error = function(jqXHR, textStatus, errorThrown) {
        if (jqXHR) {
          jqXHR.then = null;
        }
//TODO-log        console.log('ajax error', method, jqXHR);

        reject(jqXHR);
      };

      Orbit.ajax(hash);
    });
  },

  _buildURL: function(type, remoteId) {
    var host = this.host,
        namespace = this.namespace,
        url = [];

    if (host) { url.push(host); }
    if (namespace) { url.push(namespace); }
    url.push(this._pathForType(type));
    if (remoteId) { url.push(remoteId); }

    url = url.join('/');
    if (!host) { url = '/' + url; }

    return url;
  },

  _pathForType: function(type) {
    return this._pluralize(type);
  },

  _pluralize: function(name) {
    // TODO - allow for pluggable inflector
    return name + 's';
  },

  _serialize: function(type, data) {
    var serialized = clone(data);
    delete serialized[this.idField];

    if (serialized.links) {
      var links = {};
      for (var i in serialized.links) {
        var link = serialized.links[i];
        if (typeof link === 'object') {
          links[i] = Object.keys(link);
        } else {
          links[i] = link;
        }
      }
      serialized.links = links;
    }

    return serialized;
  },

  _deserialize: function(type, data) {
    return data;
  }
};

export default RestStore;