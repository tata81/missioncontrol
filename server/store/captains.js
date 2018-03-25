const redis = require('./redis');
const { aerospikeConfig, namespace } = require('../config/aerospike');
const Aerospike = require('aerospike');
const GeoJSON = Aerospike.GeoJSON;
const filter = Aerospike.filter;
const aerospike = Aerospike.client(aerospikeConfig());
const Rx = require('rxjs/Rx');

const MAX_LOCAL_RADIUS = 10e5;


const addNewCaptain = async ({ dav_id, notification_url }) => {
  await redis.hmsetAsync(`captains:${dav_id}`,
    'id', dav_id,
    'notification_url', notification_url
  );

  return dav_id;
};

const addNeedTypeForCaptain = async ({ dav_id, need_type, region }) => {
  await redis.saddAsync(`needTypes:${need_type}`, dav_id); // adds this captain davId to the needType
  await addNeedTypeIndexes(need_type);
  await aerospike.connect();
  let key = new Aerospike.Key(namespace, need_type, dav_id);
  let bins = {
    dav_id: dav_id,
    global: region.radius > MAX_LOCAL_RADIUS ? 1 : 0,
    region: new GeoJSON({ type: 'AeroCircle', coordinates: [[region.longitude, region.latitude], Math.max(region.radius, MAX_LOCAL_RADIUS)] })
  };
  let policy = new Aerospike.WritePolicy({
    exists: Aerospike.policy.exists.CREATE_OR_REPLACE
  });
  await aerospike.put(key, bins, {}, policy);
  return dav_id;
};

const addNeedToCaptain = async (davId, needId) => {
  let captainNeeds = {
    dav_id: davId,
    needs: await getNeeds(davId)
  };
  captainNeeds.needs.push(needId);
  let policy = new Aerospike.WritePolicy({
    exists: Aerospike.policy.exists.CREATE_OR_REPLACE
  });
  await aerospike.connect();
  let key = new Aerospike.Key(namespace, 'needs', davId);
  await aerospike.put(key, captainNeeds, {}, policy);
  return davId;
};

const getNeeds = async (davId) => {
  try {
    let policy = new Aerospike.WritePolicy({
      exists: Aerospike.policy.exists.CREATE_OR_REPLACE
    });
    await aerospike.connect();
    let key = new Aerospike.Key(namespace, 'needs', davId);
    return (await aerospike.get(key, policy)).bins.needs;
  }
  catch (error) {
    if (error.message.includes('Record does not exist in database')) {
      return [];
    }
    throw error;
  }
};

const createIndex = async (set, bin, type) => {
  try {
    await aerospike.createIndex({
      ns: namespace,
      set: set,
      bin: bin,
      index: `idx_${namespace}_${set}_${bin}`,
      datatype: type
    });
  } catch (error) {
    if (error.message.match(/Index .* already exists/).length === 0) {
      console.log(error);
    }
  }
};

const addNeedTypeIndexes = async (needType) => {
  await createIndex(needType, 'region', Aerospike.indexDataType.GEO2DSPHERE);
  await createIndex(needType, 'global', Aerospike.indexDataType.NUMERIC);
};

const getCaptain = async davId => {
  return await redis.hgetallAsync(`captains:${davId}`);
};

const getCaptainsForNeedType = (needType, { pickup/* , dropoff */ }) => {
  return new Promise(async (resolve, reject) => {
    try {
      const client = await aerospike.connect();
      geoQueryStreamForTerminal(pickup, needType, client)
        .toArray()
        .subscribe(async davIds => {
          await (Promise.all(davIds.map((id) => {
            return redis.hgetallAsync(`captains:${id}`);
          })))
            .then(captains =>
              resolve(captains));
        });
    } catch (err) {
      reject(err);
    }
  });
};

const query = (set, filters) => {
  let subject = new Rx.Subject();
  const query = aerospike.query(namespace, set, { filters: filters });
  const stream = query.foreach();

  stream.on('data', (record) => {
    subject.next(record);
  });

  stream.on('error', (error) => {
    subject.error(error);
  });
  stream.on('end', () => {
    subject.complete();
  });
  return subject;
};

const geoQueryStreamForTerminal = (terminal, needType) => {
  return Rx.Observable.merge(
    query(needType, [filter.geoContainsPoint('region', terminal.longitude, terminal.latitude)]),
    query(needType, [filter.equal('global', 1)])
  )
    .map(record => record.bins.dav_id);
};

module.exports = {
  addNewCaptain,
  getCaptain,
  getCaptainsForNeedType,
  addNeedTypeForCaptain,
  addNeedToCaptain,
  getNeeds
};

