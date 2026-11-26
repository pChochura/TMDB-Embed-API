const kwik = require('./kwik');
const vidneo = require('./vidneo');

module.exports = {
  ...kwik,
  ...vidneo,
  kwik,
  vidneo
};
