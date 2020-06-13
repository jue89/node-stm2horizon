// [xml path] [name] [pool base] [footprint]

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const readline = require('readline');
const xml2js = require('xml2js');
const uuidv4 = require('uuid').v4;

const readJSON = (path) => new Promise((resolve, reject) => fs.readFile(path, (err, data) => {
	if (err) reject(err);
	else resolve(JSON.parse(data.toString()));
}));

const writeJSON = (path, data) => new Promise((resolve, reject) => fs.writeFile(path, JSON.stringify(data, null, '    '), (err) => {
	if (err) reject(err);
	else resolve();
}));

const readXML = (path) => new Promise((resolve, reject) => fs.readFile(path, (err, data) => {
	if (err) return reject (err);
	xml2js.parseString(data.toString(), (err, xml) => {
		if (err) return reject(err);
		resolve(xml);
	});
}));

const TYPE2DIRECTION = {
	'Reset': 'input',
	'Boot': 'input',
	'I/O': 'bidirectional',
	'Power': 'power_input'
};

const rl = readline.createInterface({input: process.stdin, output: process.stdout});
const question = (q, env) => new Promise((resolve) => {
	const caption = q.padEnd(20);
	if (env && process.env[env]) {
		console.log(caption + process.env[env]);
		resolve(process.env[env]);
	} else {
		rl.question(caption, resolve);
	}
});
const info = (cpation, data) => console.log(cpation.padEnd(20) + data.toString());

async function readPackage ({poolPath}) {
	const packagePath = await question('Package Path?', 'PACKAGE_PATH');
	const {uuid, pads} = await readJSON(path.resolve(poolPath, packagePath));
	// Build an index for pad UUID lookup
	const padByName = Object.entries(pads).reduce((padByName, [uuid, p]) => {
		padByName[p.name] = uuid;
		return padByName;
	}, {});
	return [uuid, padByName];
}

async function readQubeMXfile () {
	const xmlPath = await question('QubeMX XML Path?', 'XML_PATH');
	const xml = await readXML(xmlPath);
	return xml.Mcu.Pin;
}

async function writePoolUnit ({poolPath, xmlPins, name, manufacturer}) {
	const unitPath = path.join(poolPath, `units/ic/mcu/stm/${name}.json`);
	const padIndex = {};
	const type = 'unit';
	const uuid = uuidv4();
	const pins = xmlPins.map((p) => {
		const direction = TYPE2DIRECTION[p.$.Type];
		assert(direction, `Unknown pin type: ${p.$.Type}`);
		const primary_name = p.$.Name.replace(/-.*$/, '');
		const names = p.Signal ? p.Signal.map((s) => s.$.Name) : [];
		const swap_group = 0;
		const pad = p.$.Position;
		return {direction, names, primary_name, swap_group, pad};
	}).sort((a, b) => {
		if (a.primary_name > b.primary_name) return 1;
		if (a.primary_name < b.primary_name) return -1;
		return 0;
	}).reduce((pins, p) => {
		const uuid = uuidv4();
		padIndex[p.pad] = uuid;
		delete p.pad;
		pins[uuid] = p;
		return pins;
	}, {});
	await writeJSON(unitPath, {manufacturer, name, pins, type, uuid});
	console.log(`Written ${unitPath}`);
	return [uuid, padIndex];
}

async function writePoolEntity ({poolPath, unitUUID, name, manufacturer, prefix, tags}) {
	const entityPath = path.join(poolPath, `entities/ic/mcu/stm/${name}.json`);
	const gates = {};
	const gateUUID = uuidv4();
	gates[gateUUID] = {
		name: 'Main',
		suffix: '',
		swap_group: 0,
		unit: unitUUID
	};
	const type = 'entity';
	const uuid = uuidv4();
	await writeJSON(entityPath, {gates, manufacturer, name, prefix, tags, type, uuid});
	console.log(`Written ${entityPath}`);
	return [uuid, gateUUID];
}

async function writePoolPart ({poolPath, entityUUID, packageUUID, gateUUID, padIndex, padByName, name, manufacturer, tags}) {
	const partPath = path.join(poolPath, `parts/ic/mcu/stm/${name}.json`);
	writeJSON(partPath, {
		'MPN': [false, name],
		'datasheet': [false, await question('Datasheet URL?', 'DATASHEET_URL')],
		'description': [false, await question('Description?', 'DESCRIPTION')],
		'entity': entityUUID,
		'inherit_model': true,
		'inherit_tags': false,
		'manufacturer': [false, manufacturer],
		'orderable_MPNs': {},
		'package': packageUUID,
		'pad_map': Object.entries(padIndex).reduce((pad_map, [padName, pinUUID]) => {
			pad_map[padByName[padName]] = {
				gate: gateUUID,
				pin: pinUUID
			};
			return pad_map;
		}, {}),
		'parametric': {},
		'tags': tags,
		'type': 'part',
		'uuid': uuidv4(),
		'value': [false, '']
	});
	console.log(`Written ${partPath}`);
}


(async function stm2horizon () {
	const manufacturer = 'ST';
	const prefix = 'U';
	const tags = ['arm', 'ic', 'mcu', 'stm32'];

	const poolPath = await question('Pool Path?', 'POOL_PATH');
	const [packageUUID, padByName] = await readPackage({poolPath});
	info('Pad Count:', Object.keys(padByName).length);
	const xmlPins = await readQubeMXfile();

	// Some sanity checks if package and XML are compatible
	assert(Object.keys(padByName).length === xmlPins.length, 'Pin and pad count mismatch!');
	assert(xmlPins.reduce((ok, p) => ok && padByName[p.$.Position], true), 'Cannot align pad names with XML pin names');

	const name = await question('Part Name?', 'PART_NAME');
	const [unitUUID, padIndex] = await writePoolUnit({poolPath, xmlPins, name, manufacturer});
	const [entityUUID, gateUUID] = await writePoolEntity({poolPath, unitUUID, name, manufacturer, prefix, tags});
	await writePoolPart({poolPath, entityUUID, packageUUID, gateUUID, padIndex, padByName, name, manufacturer, tags});
})().catch((err) => console.error(err)).then(() => rl.close());
