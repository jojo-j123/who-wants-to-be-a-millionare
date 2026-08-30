// Generates data/questions.json from a compact table.
// Run: node scripts/seed-questions.js
const fs = require('fs');
const path = require('path');

// [question, a, b, c, d, correctIndex, difficulty(1-3), category]
const rows = [
  ["Which planet is known as the Red Planet?","Venus","Mars","Jupiter","Mercury",1,1,"Science"],
  ["How many days are there in a leap year?","364","365","366","367",2,1,"General"],
  ["What is the largest ocean on Earth?","Atlantic","Indian","Arctic","Pacific",3,1,"Geography"],
  ["Which animal is known as the King of the Jungle?","Tiger","Lion","Elephant","Bear",1,1,"Nature"],
  ["How many sides does a hexagon have?","Five","Six","Seven","Eight",1,1,"Math"],
  ["What colour do you get by mixing red and white?","Purple","Orange","Pink","Grey",2,1,"General"],
  ["Which gas do humans need to breathe to survive?","Nitrogen","Hydrogen","Oxygen","Helium",2,1,"Science"],
  ["What is the capital city of France?","Rome","Madrid","Berlin","Paris",3,1,"Geography"],
  ["How many continents are there on Earth?","Five","Six","Seven","Eight",2,1,"Geography"],
  ["Which fruit is famous for keeping the doctor away?","Banana","Apple","Orange","Grape",1,1,"General"],
  ["What is the freezing point of water in Celsius?","0","32","100","-10",0,1,"Science"],
  ["Which instrument has 88 keys?","Guitar","Violin","Piano","Flute",2,1,"Music"],
  ["How many players are on a football (soccer) team on the pitch?","9","10","11","12",2,1,"Sport"],
  ["What is the largest mammal in the world?","Elephant","Blue whale","Giraffe","Hippo",1,1,"Nature"],
  ["Which shape has no sides at all?","Triangle","Square","Circle","Pentagon",2,1,"Math"],

  ["Who painted the Mona Lisa?","Michelangelo","Leonardo da Vinci","Raphael","Donatello",1,2,"Art"],
  ["What is the chemical symbol for gold?","Go","Gd","Au","Ag",2,2,"Science"],
  ["In which year did the Second World War end?","1943","1944","1945","1946",2,2,"History"],
  ["Which country gifted the Statue of Liberty to the USA?","Britain","France","Spain","Italy",1,2,"History"],
  ["What is the longest river in the world?","Amazon","Nile","Yangtze","Mississippi",1,2,"Geography"],
  ["How many bones are there in the adult human body?","186","206","226","246",1,2,"Science"],
  ["Which planet has the most moons discovered so far?","Jupiter","Saturn","Uranus","Neptune",1,2,"Science"],
  ["Who wrote the play 'Romeo and Juliet'?","Charles Dickens","William Shakespeare","Jane Austen","Mark Twain",1,2,"Literature"],
  ["What is the smallest country in the world by area?","Monaco","Nauru","Vatican City","San Marino",2,2,"Geography"],
  ["Which element has the atomic number 1?","Helium","Hydrogen","Lithium","Carbon",1,2,"Science"],
  ["In computing, what does 'CPU' stand for?","Central Process Unit","Computer Personal Unit","Central Processing Unit","Control Program Utility",2,2,"Technology"],
  ["Which sea is the saltiest body of water on Earth?","Red Sea","Dead Sea","Black Sea","Caspian Sea",1,2,"Geography"],
  ["How many strings does a standard violin have?","Four","Five","Six","Seven",0,2,"Music"],
  ["Which country hosted the 2016 Summer Olympics?","China","Brazil","Japan","Greece",1,2,"Sport"],
  ["What is the hardest natural substance on Earth?","Quartz","Steel","Diamond","Granite",2,2,"Science"],

  ["Which scientist proposed the three laws of motion?","Albert Einstein","Isaac Newton","Galileo Galilei","Niels Bohr",1,3,"Science"],
  ["What is the currency of Switzerland?","Euro","Krona","Franc","Lira",2,3,"General"],
  ["In which year did the Berlin Wall fall?","1987","1988","1989","1990",2,3,"History"],
  ["Which novel begins with the line 'Call me Ishmael'?","Moby-Dick","The Old Man and the Sea","Treasure Island","Robinson Crusoe",0,3,"Literature"],
  ["What is the capital of Mongolia?","Astana","Ulaanbaatar","Bishkek","Tashkent",1,3,"Geography"],
  ["Who composed 'The Four Seasons'?","Bach","Mozart","Vivaldi","Handel",2,3,"Music"],
  ["Which is the only mammal capable of true sustained flight?","Flying squirrel","Bat","Colugo","Sugar glider",1,3,"Nature"],
  ["What does 'HTTP' stand for?","HyperText Transfer Protocol","High Transfer Text Protocol","HyperText Transmission Process","Host Transfer Text Protocol",0,3,"Technology"],
  ["Which country has the longest coastline in the world?","Russia","Australia","Canada","Indonesia",2,3,"Geography"],
  ["In Greek mythology, who flew too close to the sun?","Icarus","Perseus","Theseus","Orpheus",0,3,"Mythology"],
  ["What is the study of fungi called?","Mycology","Etymology","Ornithology","Herpetology",0,3,"Science"],
  ["Which artist cut off part of his own ear?","Claude Monet","Vincent van Gogh","Pablo Picasso","Paul Gauguin",1,3,"Art"],
  ["How many time zones does Russia span?","9","11","13","15",1,3,"Geography"],
  ["What is the rarest blood type in humans?","O negative","AB negative","B negative","A negative",1,3,"Science"],
  ["Which planet takes the longest to orbit the Sun?","Saturn","Uranus","Neptune","Pluto",2,3,"Science"]
];

const questions = rows.map((r, i) => ({
  id: 'q' + String(i + 1).padStart(3, '0'),
  text: r[0],
  answers: [r[1], r[2], r[3], r[4]],
  correct: Number(r[5]),
  difficulty: r[6],
  category: r[7]
}));

const bad = questions.filter(q => !(q.correct >= 0 && q.correct <= 3));
if (bad.length) {
  console.error('Invalid correct index in:', bad.map(q => q.id).join(', '));
  process.exit(1);
}

const out = { version: 1, questions };
fs.writeFileSync(path.join(__dirname, '..', 'data', 'questions.json'), JSON.stringify(out, null, 2) + '\n');
console.log('Wrote ' + questions.length + ' questions.');
