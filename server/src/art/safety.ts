// One shelf, safe for a young child (PLAN-art.md, section 10). A small deny list refuses a subject at `draw` time, before the shelf is asked:
// real people, brands, named characters, and anything not meant for a young child. It is a net and not a promise: the vetting of a sheet
// ("suitable for a young child") is the other half, and a refused subject is only ever drawn as a soft placeholder with a note that says why.

export type Refusal = 'a real person' | 'a brand' | 'a named character' | 'not for a young child';

const PEOPLE = [
  'donald trump', 'trump', 'joe biden', 'biden', 'obama', 'putin', 'zelensky', 'macron', 'king charles', 'queen elizabeth', 'taylor swift', 'beyonce', 'elon musk', 'jeff bezos',
  'mark zuckerberg', 'bill gates', 'steve jobs', 'messi', 'ronaldo', 'lebron', 'kardashian', 'justin bieber', 'drake', 'rihanna', 'kanye', 'oprah', 'pope francis', 'the pope',
  'einstein', 'napoleon', 'hitler', 'stalin', 'mussolini', 'churchill', 'gandhi', 'celebrity', 'president', 'prime minister',
];
const BRANDS = [
  'nike', 'adidas', 'coca cola', 'coke', 'pepsi', 'mcdonald', 'mcdonalds', 'starbucks', 'apple logo', 'iphone', 'google', 'microsoft', 'amazon', 'facebook', 'instagram', 'tiktok',
  'youtube', 'netflix', 'disney', 'pixar', 'lego', 'ferrari', 'lamborghini', 'tesla', 'bmw', 'mercedes', 'toyota', 'ikea', 'nintendo', 'playstation', 'xbox', 'kfc', 'burger king',
  'chanel', 'gucci', 'louis vuitton', 'rolex', 'logo', 'trademark',
];
const CHARACTERS = [
  'mickey', 'minnie', 'donald duck', 'goofy', 'mario', 'luigi', 'bowser', 'zelda', 'link', 'pikachu', 'pokemon', 'charizard', 'sonic', 'spiderman', 'spider man', 'batman', 'superman',
  'wonder woman', 'iron man', 'hulk', 'thor', 'captain america', 'avengers', 'elsa', 'anna', 'olaf', 'moana', 'simba', 'mufasa', 'nemo', 'dory', 'woody', 'buzz lightyear', 'shrek',
  'winnie', 'pooh', 'tigger', 'eeyore', 'peppa', 'peppa pig', 'bluey', 'paw patrol', 'minion', 'hello kitty', 'snoopy', 'charlie brown', 'garfield', 'tom and jerry', 'bugs bunny',
  'daffy', 'scooby', 'spongebob', 'patrick star', 'barbie', 'harry potter', 'hermione', 'gandalf', 'frodo', 'darth vader', 'vader', 'yoda', 'stormtrooper', 'baby yoda', 'grogu',
  'totoro', 'doraemon', 'naruto', 'goku', 'santa claus', 'santa', 'peter pan', 'cinderella', 'rapunzel', 'ariel', 'belle', 'jasmine', 'aladdin', 'stitch', 'dora', 'elmo',
  'cookie monster', 'big bird', 'kermit', 'miss piggy', 'thomas the tank engine', 'gruffalo', 'paddington',
];
const NOT_FOR_A_CHILD = [
  'gun', 'pistol', 'rifle', 'firearm', 'shotgun', 'weapon', 'bomb', 'grenade', 'missile', 'knife', 'dagger', 'blood', 'gore', 'corpse', 'dead body', 'murder', 'kill', 'killing',
  'suicide', 'naked', 'nude', 'nudity', 'sex', 'sexy', 'porn', 'erotic', 'lingerie', 'drug', 'drugs', 'cocaine', 'heroin', 'weed', 'cannabis', 'marijuana', 'beer', 'wine', 'vodka',
  'whisky', 'whiskey', 'alcohol', 'cigarette', 'cigar', 'vape', 'smoking', 'swastika', 'nazi', 'terrorist', 'terrorism', 'torture', 'skull', 'zombie', 'demon', 'satan', 'devil',
  'war', 'massacre', 'execution', 'noose', 'coffin', 'grave', 'slave', 'racist', 'gambling', 'casino', 'stripper',
];

const TABLE: readonly (readonly [Refusal, readonly string[]])[] = [
  ['a real person', PEOPLE],
  ['a brand', BRANDS],
  ['a named character', CHARACTERS],
  ['not for a young child', NOT_FOR_A_CHILD],
];

const words = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/'s\b/g, '').split(/\s+/).filter((word) => word !== '');

/** Why a subject (or the detail said with it) is not drawn, or null. A phrase is matched as whole words, so `link` does not refuse `blink` or `chain link fence`'s `chain`. */
export function refusalOf(subject: string, detail = ''): Refusal | null {
  const said = ` ${words(`${subject} ${detail}`).join(' ')} `;
  const bare = ` ${words(`${subject} ${detail}`).map((word) => word.replace(/(?:es|s)$/, '')).join(' ')} `;
  for (const [why, list] of TABLE) {
    for (const entry of list) {
      if (said.includes(` ${entry} `) || bare.includes(` ${entry} `)) return why;
    }
  }
  return null;
}
