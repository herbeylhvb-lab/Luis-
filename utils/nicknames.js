// Bidirectional nickname map for captain contact matching.
// Keys are canonical legal names from voter files; values are common informal forms.
// Expand over time with district-specific entries.

module.exports = {
  // Male
  'Robert':    ['Bob', 'Bobby', 'Rob', 'Robbie', 'Bert'],
  'William':   ['Will', 'Bill', 'Billy', 'Willie', 'Liam'],
  'James':     ['Jim', 'Jimmy', 'Jamie'],
  'John':      ['Jon', 'Johnny', 'Jack'],
  'Richard':   ['Rich', 'Rick', 'Ricky', 'Dick', 'Richie'],
  'Michael':   ['Mike', 'Mickey', 'Mick', 'Mikey'],
  'Charles':   ['Charlie', 'Chuck', 'Chas'],
  'Christopher': ['Chris', 'Topher', 'Kit'],
  'Joseph':    ['Joe', 'Joey', 'Jos'],
  'Thomas':    ['Tom', 'Tommy', 'Thom'],
  'Daniel':    ['Dan', 'Danny'],
  'Anthony':   ['Tony', 'Ant'],
  'Andrew':    ['Andy', 'Drew'],
  'Edward':    ['Ed', 'Eddie', 'Ted', 'Teddy', 'Ned'],
  'Nicholas':  ['Nick', 'Nicky'],
  'Benjamin':  ['Ben', 'Benny', 'Benji'],
  'Matthew':   ['Matt', 'Matty'],
  'Timothy':   ['Tim', 'Timmy'],
  'Jose':      ['Pepe', 'Pepito', 'Joselito'],
  'Francisco': ['Paco', 'Pancho', 'Frank'],

  // Female
  'Elizabeth': ['Liz', 'Lizzy', 'Beth', 'Betty', 'Eliza', 'Betsy', 'Libby'],
  'Margaret':  ['Maggie', 'Meg', 'Peggy', 'Marge', 'Madge'],
  'Catherine': ['Cathy', 'Kate', 'Katie', 'Kathy', 'Cat'],
  'Katherine': ['Kathy', 'Kate', 'Katie', 'Kat'],
  'Patricia':  ['Pat', 'Patty', 'Trish', 'Tricia'],
  'Jennifer':  ['Jen', 'Jenny', 'Jenn'],
  'Susan':     ['Sue', 'Susie', 'Suzy'],
  'Deborah':   ['Deb', 'Debbie'],
  'Barbara':   ['Barb', 'Barbie'],
  'Rebecca':   ['Becky', 'Becca', 'Reba'],
  'Maria':     ['Mary', 'Mari', 'Mia'],
  'Guadalupe': ['Lupe', 'Lupita'],
};
