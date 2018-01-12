'use strict';
const VectorTile = require('@mapbox/vector-tile').VectorTile;
const Protobuf = require('pbf');
const opath = require('object-path');
const CachedVectorTile = require('cached-vector-tile');
const LRUCache = require('../util/lru_cache');
const ajax = require('../util/ajax');
const util = require('../util/util');
const WorkerTile = require('./worker_tile');

// cache up to 4 vector tiles per worker that is usually enough to cover the
// map even if there is only *one*
const cache = new LRUCache(1 + 4 + 16, () => true);
const preloading = {};

function getCachedTile (url, callback) {
    let cached = cache.get(url);
    if (cached) {
        cache.add(url, cached);
        return callback(null, cached);
    }

    if (preloading[url]) {
        preloading[url].push(callback);
        return;
    }

    preloading[url] = [callback];
    callback = function onCachedTileLoaded (err, result) {
        const callbacks = preloading[url];
        delete preloading[url];
        callbacks.forEach((cb) => cb(err, result));
    };

    ajax.getArrayBuffer(url, (err, rawTileData) => {
        if (err) { return callback(err); }
        const vt = new CachedVectorTile(new VectorTile(new Protobuf(rawTileData)));
        cached = {
            tile: vt.serialize(),
            buffer: rawTileData
        };
        cache.add(url, cached);
        callback(null, cached);
    });
}


// [feature id] => { /* properties */ }
const _data = {};
function updatePropertyData (propertyData) {
    if (propertyData) {
        for (const id in propertyData) {
            if (typeof propertyData[id] !== 'undefined') {
                _data[id] = propertyData[id];
            }
        }
    }
}

function setTileProperties (vt, propertyData) {
    for (const layerId in vt.layers) {
        const layer = vt.layers[layerId];
        for (let i = 0; i < layer._features.length; i++) {
            const feature = layer._features[i];
            const id = feature.properties.id;
            if (typeof id !== 'undefined') {
                feature.properties = opath.get(propertyData, id, feature.properties);
            }
        }
    }
}

module.exports = SharedVectorWorker;

function SharedVectorWorker (actor, layerIndex) {
    this.actor = actor;
    this.layerIndex = layerIndex;
    this.loading = {};
    this.loaded = {};
}

SharedVectorWorker.prototype = {
  /**
   * Implements {@link WorkerSource#loadTile}.
   *
   * @param {object} params
   * @param {string} params.source The id of the source for which we're loading this tile.
   * @param {string} params.uid The UID for this tile.
   * @param {TileCoord} params.coord
   * @param {number} params.zoom
   * @param {number} params.overscaling
   * @param {number} params.angle
   * @param {number} params.pitch
   * @param {boolean} params.showCollisionBoxes
   * @private
   */
    loadTile: function (params, callback) {
        const source = params.source;
        const uid = params.uid;

        updatePropertyData(params.propertyData);

        if (!this.loading[source]) {
            this.loading[source] = {};
        }

        const workerTile = this.loading[source][uid] = new WorkerTile(params);

        getCachedTile(params.url, (err, cached) => {
            delete this.loading[source][uid];

            if (err) { return callback(err); }

            const vt = new CachedVectorTile(cached.tile);
            setTileProperties(vt, _data);
            const rawTileData = cached.buffer.slice(0);
            workerTile.vectorTile = vt;
            workerTile.parse(vt, this.layerIndex, this.actor, (err, result, transferrables) => {
                if (err) { return callback(err); }
        // Not transferring rawTileData because the worker needs to retain its copy.
                callback(null,
                    util.extend({rawTileData: rawTileData}, result),
                    transferrables);
            });

            this.loaded[source] = this.loaded[source] || {};
            this.loaded[source][uid] = workerTile;
        });
    },

    reloadTile: function (params, callback) {
        updatePropertyData(params.propertyData);

        const loaded = this.loaded[params.source];
        const uid = params.uid;
        if (loaded && loaded[uid]) {
            const workerTile = loaded[uid];
            setTileProperties(workerTile.data, _data);
            workerTile.parse(workerTile.data, this.layerIndex, this.actor, callback);
        } else {
            util.warnOnce(`Cannot reload tile ${params.source} - ${JSON.stringify(params.coord)}`);
            this.loadTile(params, callback);
        }
    },

    abortTile: function (params) {
        const loading = this.loading[params.source];
        const uid = params.uid;
        if (loading && loading[uid] && loading[uid].abort) {
            loading[uid].abort();
            delete loading[uid];
        }
    },

    removeTile: function (params) {
        const source = params.source;
        const uid = params.uid;
        if (this.loaded[source] && this.loaded[source][uid]) {
            delete this.loaded[source][uid];
        }
    }
};
