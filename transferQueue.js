var chunkSize = 0.5 * 1024 * 1024; // 0.5MB; can be changed
var uploadStartTime; // for testing

TransferQueue = function(isUpload) {
  var self = this, name;
  if (isUpload) {
    name = 'UploadTransferQueue';
    self.isUploadQueue = true;
  } else {
    name = 'DownloadTransferQueue';
    self.isUploadQueue = false;
  }
  self.queue = new PowerQueue(name);

  // Persistent but client-only collection
  self.collection = new Meteor.Collection(name, {connection: null});

  // This "paused" is slightly different from that of self.queue because
  // this one indicates whether the user wants the queue to be paused
  // whereas the other indicates whether the queue is actually paused,
  // which could be because of having no tasks to run.
  self._paused = false;
  self._progressPercent = 100;
  self._perFileProgress = {};
  if (Meteor.isClient) {
    self._progressPercentDeps = new Deps.Dependency();
    self._pausedDeps = new Deps.Dependency();
    self._queuePausedDeps = new Deps.Dependency();
  }

  // Make queue update reactive queue progress / status
  self.queue.progress = function(left, total) {
    var c = total - left;
    var p = (total === 0) ? 0 : Math.round(c / total * 100);
    if (p !== self._progressPercent) {
      self._progressPercent = p;
      if (self._progressPercentDeps) {
        self._progressPercentDeps.changed();
      }
      if (self._queuePausedDeps) {
        self._queuePausedDeps.changed();
      }
    }
  };

  // If there are any uploads or downloads in the cache,
  // finish them at client load.
  Meteor.startup(function() {
    if (self._progressPercentDeps) {
      self.collection.find().observeChanges(function() {
        self._progressPercentDeps.changed();
      });
    }

    self.collection.find({type: "download", data: null}).forEach(function(doc) {
      downloadChunk(self, doc.fo, doc.selector, doc.start);
    });
  });
};

TransferQueue.prototype.cacheUpload = function(fsFile, start, callback) {
  var self = this;
  var existing = self.collection.findOne({fileId: fsFile._id, collectionName: fsFile.collectionName, start: start, type: "upload"});
  if (existing) {
    // If already cached, don't do it again
    callback();
  } else {
    self.collection.insert({fileId: fsFile._id, collectionName: fsFile.collectionName, start: start, type: "upload"}, function(e, r) {
      callback(e, r);
    });
  }
};

TransferQueue.prototype.markChunkUploaded = function(fsFile, start, callback) {
  var self = this;
  if (typeof start === "number") {
    // Mark each chunk done for progress tracking
    self.collection.update({fileId: fsFile._id, collectionName: fsFile.collectionName, start: start, type: "upload"}, {$set: {done: true}}, function(e, r) {
      if (e) {
        callback(e);
      } else {
        var totalChunks = Math.ceil(fsFile.size / chunkSize);
        var doneChunks = self.collection.find({fileId: fsFile._id, collectionName: fsFile.collectionName, type: "upload", done: true});
        if (totalChunks === doneChunks.count()) {
          console.log("Upload finished after", (((new Date).getTime()) - uploadStartTime), "ms");
          self.unCacheUpload(fsFile, callback);
        } else {
          callback();
        }
      }
    });
  } else {
    // No need to mark anything done since it was quick
    self.unCacheUpload(fsFile, callback);
  }
};

TransferQueue.prototype.unCacheUpload = function(fsFile, callback) {
  var self = this;
  self.collection.remove({fileId: fsFile._id, collectionName: fsFile.collectionName, type: "upload"}, callback);
};

TransferQueue.prototype.cacheDownload = function(fsFile, selector, start, callback) {
  var self = this;
  if (self.collection.findOne({fileId: fsFile._id, collectionName: fsFile.collectionName, selector: selector, start: start, type: "download"})) {
    // If already cached, don't do it again
    callback();
    return;
  }
  self.collection.insert({fileId: fsFile._id, collectionName: fsFile.collectionName, selector: selector, start: start, type: "download"}, callback);
};

TransferQueue.prototype.addDownloadedData = function(fsFile, selector, start, data, callback) {
  var self = this;

  function save(data) {
    fsFile.setDataFromBinary(data);
    var filename = (typeof selector === "string") ? fsFile.copies[selector].name : fsFile.master.name;
    fsFile.saveLocal(filename);
    // Now that we've saved it, clear the cache
    self.unCacheDownload(fsFile, selector, callback);
  }

  if (typeof start === "number") {
    self.collection.update({fileId: fsFile._id, collectionName: fsFile.collectionName, selector: selector, start: start, type: "download"}, {$set: {data: data}}, function(err) {
      if (err) {
        callback(err);
        return;
      }
      var totalChunks = Math.ceil(fsFile.size / chunkSize);
      var cachedChunks = self.collection.find({fileId: fsFile._id, collectionName: fsFile.collectionName, selector: selector, type: "download", data: {$exists: true}}, {sort: {start: 1}});
      var cnt = cachedChunks.count();
      console.log("Downloaded", cnt, "of", totalChunks);
      if (totalChunks === cnt) {
        // All chunks have been downloaded into the cache
        // Combine chunks
        console.log("Loading chunks into file object");
        var bin = EJSON.newBinary(fsFile.size), r = 0;
        cachedChunks.rewind();
        cachedChunks.forEach(function(chunkCache) {
          var d = chunkCache.data;
          for (var i = 0, ln = d.length; i < ln; i++) {
            bin[r] = d[i];
            r++;
          }
        });
        // Save combined data
        save(bin);
      } else {
        callback();
      }
    });
  } else {
    // There is just one chunk, so save the downloaded file.
    save(data);
  }
};

TransferQueue.prototype.unCacheDownload = function(fsFile, selector, callback) {
  var self = this;
  self.collection.remove({fileId: fsFile._id, collectionName: fsFile.collectionName, selector: selector, type: "download"}, callback);
};

var uploadChunk = function(tQueue, fsFile, start, end) {
  var collection = _collections[fsFile.collectionName];
  console.log("uploadChunk");
  if (typeof collection === 'undefined') {
    throw new Error('TransferQueue upload failed FS.Collection "' + fsFile.collectionName + '" not found');
  }
  tQueue.cacheUpload(fsFile, start, function() {
    tQueue.queue.add(function(complete) {
      console.log("uploading bytes " + start + " to " + end + " of " + fsFile.size);
      fsFile.getBinary(start, end, function(err, data) {
        if (err) {
          complete();
          throw err;
        }
        var b = new Date;
        Meteor.apply(collection.methodName + '/put',
                [fsFile, data, start],
                function(err) {
                  var e = new Date;
                  console.log("server took " + (e.getTime() - b.getTime()) + "ms");
                  if (!err) {
                    tQueue.markChunkUploaded(fsFile, start, function() {
                      complete();
                    });
                  }
                });
      });
    });
    if (end >= fsFile.size) {
      tQueue.queue.run();
    }
  });
};

// This is done as a recursive function rather than a loop so that
// the closure variables will be correct when the queue tasks are run.
var uploadChunks = function(tQueue, fsFile, size, chunks, chunk) {
  size = size || fsFile.size;
  if (typeof size !== 'number') {
    throw new Error('TransferQueue upload failed: fsFile size not set');
  }

  chunks = chunks || Math.ceil(size / chunkSize);
  chunk = chunk || 0;
  var start = chunk * chunkSize;
  var end = start + chunkSize;
  if (chunks === 1) {
    start = null; //It's a small file. Upload all data in a single method call
  }
  uploadChunk(tQueue, fsFile, start, end);
  if (chunk < chunks - 1) {
    uploadChunks(tQueue, fsFile, size, chunks, chunk + 1);
  }
};

TransferQueue.prototype.uploadFile = function(fsFile) {
  var self = this;
  console.log('transferQueue: uploadFile');
  uploadStartTime = Date.now();
  Meteor.setTimeout(function() {
    uploadChunks(self, fsFile);
  });
};

// Downloading is a bit different from uploading. We cache data as it comes back
// rather than before making the method calls.
var downloadChunk = function(tQueue, fsFile, selector, start, isLast) {
  var collection = _collections[fsFile.collectionName];
  if (typeof collection === 'undefined') {
    throw new Error('TransferQueue upload failed FS.Collection "' + fsFile.collectionName + '" not found');
  }

  tQueue.cacheDownload(fsFile, selector, start, function(err) {
    tQueue.queue.add(function(complete) {
      Meteor.apply(collection.methodName + '/get',
              [fsFile, selector, start],
              {
                wait: true
              },
      function(err, data) {
        if (err) {
          complete();
          throw err;
        } else {
          tQueue.addDownloadedData(fsFile, selector, start, data, function(err) {
            complete();
          });
        }
      });
    });
    isLast && tQueue.queue.run();
  });
};

// This is done as a recursive function rather than a loop so that
// the closure variables will be correct when the queue tasks are run.
var downloadChunks = function(tQueue, fsFile, selector, size, chunks, chunk) {
  if (typeof size !== 'number') {
    if (selector) {
      size = fsFile.copies[selector].size;
    } else {
      size = fsFile.master.size;
    }
  }

  if (typeof size !== 'number') {
    throw new Error('TransferQueue download failed: fsFile size not set');
  }

  chunks = chunks || Math.ceil(size / chunkSize);
  chunk = chunk || 0;

  var start = chunk * chunkSize;
  var end = start + chunkSize;
  console.log("downloadChunks: chunk " + chunk + " of " + chunks + " where start is " + start + " and end is " + end + " and file size is " + fsFile.size);
  if (chunks === 1) {
    start = null; //It's a small file. Upload all data in a single method call
  }

  var done = (chunk >= chunks - 1);
  downloadChunk(tQueue, fsFile, selector, start, done);
  if (!done) {
    downloadChunks(tQueue, fsFile, selector, size, chunks, chunk + 1);
  }
};

TransferQueue.prototype.downloadFile = function(/* fsFile, copyName */) {
  var self = this;

  var args = parseArguments(arguments,
          ["fsFile", ["copyName"]],
          [FS.File, String]);
  if (args instanceof Error)
    throw args;
  var fsFile = args.fsFile,
          copyName = args.copyName;

  // Load via DDP
  console.log('transferQueue: downloadFile');
  Meteor.setTimeout(function() {
    downloadChunks(self, fsFile, copyName);
  });
};

TransferQueue.prototype.isUploadingFile = function(fsFile) {
  var self = this;
  return !!self.collection.findOne({fileId: fsFile._id, collectionName: fsFile.collectionName, type: "upload"});
};

TransferQueue.prototype.isDownloadingFile = function(fsFile, selector) {
  var self = this;
  selector = selector || null;
  return !!self.collection.findOne({fileId: fsFile._id, collectionName: fsFile.collectionName, selector: selector, type: "download"});
};

TransferQueue.prototype.isPaused = function() {
  var self = this;
  if (self._pausedDeps) {
    self._pausedDeps.depend();
  }
  return self._paused;
};

TransferQueue.prototype.isRunning = function() {
  var self = this;
  if (self._queuePausedDeps) {
    self._queuePausedDeps.depend();
  }
  return !self.queue.paused;
};

TransferQueue.prototype.pause = function() {
  var self = this;
  self.queue.pause();
  self._paused = true;
  if (self._pausedDeps) {
    self._pausedDeps.changed();
  }
};

TransferQueue.prototype.resume = function() {
  var self = this;
  self.queue.run();
  self._paused = false;
  if (self._pausedDeps) {
    self._pausedDeps.changed();
  }
};

TransferQueue.prototype.cancel = function() {
  var self = this;
  self.queue.reset();
  if (self.isUploadQueue) {
    self.collection.remove({type: "upload"});
  } else {
    self.collection.remove({type: "download"});
  }
  self._paused = false;
  if (self._pausedDeps) {
    self._pausedDeps.changed();
  }
};

// Reactive status percent for the queue in total
TransferQueue.prototype.progress = function(fsFile, selector) {
  var self = this;
  if (self._progressPercentDeps) {
    self._progressPercentDeps.depend();
  }
  if (fsFile) {
    if (self.isUploadQueue) {
      var totalChunks = Math.ceil(fsFile.size / chunkSize);
      var uploadedChunks = self.collection.find({fileId: fsFile._id, collectionName: fsFile.collectionName, type: "upload", done: true}).count();
      return Math.round(uploadedChunks / totalChunks * 100);
    } else {
      selector = selector || null;
      var totalChunks = Math.ceil(fsFile.size / chunkSize);
      var downloadedChunks = self.collection.find({fileId: fsFile._id, collectionName: fsFile.collectionName, selector: selector, type: "download", data: {$exists: true}}).count();
      return Math.round(downloadedChunks / totalChunks * 100);
    }
  } else {
    return self._progressPercent;
  }
};