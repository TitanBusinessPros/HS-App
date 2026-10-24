// Keep these built-in IDs and their order stable. Saved entries use them.
export const skillCategories = [
  { name: 'Poultry', skills: [
    'Chicken Farmer', 'Duck Keeping', 'Goose Keeping', 'Turkey Raising', 'Quail Raising',
    'Egg Production', 'Poultry Breeding', 'Incubation and Brooding', 'Poultry Health', 'Poultry Processing'
  ] },
  { name: 'Livestock and Bees', skills: [
    'Cattle Care', 'Dairy Cattle', 'Goat Care', 'Sheep Care', 'Pig Raising',
    'Rabbit Raising', 'Horse Care', 'Beekeeping', 'Pasture Management', 'Animal Nutrition'
  ] },
  { name: 'Gardening and Crops', skills: [
    'Vegetable Gardening', 'Fruit Orchard Care', 'Berry Growing', 'Herb Growing', 'Greenhouse Growing',
    'Seed Starting', 'Seed Saving', 'Soil Preparation', 'Crop Rotation', 'Garden Pest Management'
  ] },
  { name: 'Land and Water', skills: [
    'Irrigation Systems', 'Drip Irrigation', 'Rainwater Harvesting', 'Well Maintenance', 'Water Filtration',
    'Drainage Planning', 'Pond Management', 'Erosion Control', 'Composting', 'Land Clearing'
  ] },
  { name: 'Food and Pantry', skills: [
    'Pressure Canning', 'Water Bath Canning', 'Food Dehydrating', 'Fermentation', 'Freezing Produce',
    'Butchery', 'Meat Curing', 'Cheese Making', 'Bread Baking', 'Meal Planning'
  ] },
  { name: 'Building and Equipment', skills: [
    'Carpentry', 'Fence Building', 'Welding', 'Plumbing Repairs', 'Electrical Repairs',
    'Small Engine Repair', 'Tractor Operation', 'Tractor Maintenance', 'Barn Repair', 'Roofing'
  ] },
  { name: 'Energy and Utilities', skills: [
    'Solar Power', 'Battery Systems', 'Generator Maintenance', 'Wood Stove Operation', 'Firewood Processing',
    'Propane Systems', 'Energy Conservation', 'Off-Grid Sanitation', 'Septic Maintenance', 'Emergency Power Planning'
  ] },
  { name: 'Farm Operations', skills: [
    'Farm Budgeting', 'Record Keeping', 'Inventory Management', 'Crop Planning', 'Livestock Records',
    'Supply Purchasing', 'Farm Sales', 'Farmers Market Sales', 'Permaculture Design', 'Farm Safety'
  ] },
  { name: 'Outdoors and Conservation', skills: [
    'Tree Planting', 'Forestry', 'Fire Prevention', 'Wildfire Preparedness', 'Trail Maintenance',
    'Wildlife Management', 'Rotational Grazing', 'Native Planting', 'Foraging', 'Hunting and Field Dressing'
  ] },
  { name: 'Household and Community', skills: [
    'First Aid', 'Cooking for Groups', 'Childcare', 'Teaching Skills', 'Volunteer Coordination',
    'Conflict Resolution', 'Shared Chore Planning', 'Community Outreach', 'Event Planning', 'Homestead Planning'
  ] }
];

export const skills = skillCategories.flatMap(category =>
  category.skills.map(name => ({ category: category.name, name }))
).map((skill, id) => ({ ...skill, id }));

export function buildSkillCatalog(customSkills = []) {
  const deleted = new Set(customSkills.filter(skill => skill.deleted === true).map(skill => String(skill.id)));
  const categories = skillCategories.map(category => category.name);
  const byCategory = new Map(categories.map(name => [name.toLowerCase(), name]));
  const all = skills.filter(skill => !deleted.has(String(skill.id)));
  const sorted = customSkills.filter(skill => skill.deleted !== true).sort((a, b) =>
    String(a.category).localeCompare(String(b.category)) || String(a.name).localeCompare(String(b.name)));
  for (const skill of sorted) {
    if (typeof skill.id !== 'string' || typeof skill.name !== 'string' || typeof skill.category !== 'string') continue;
    const key = skill.category.toLowerCase();
    if (!byCategory.has(key)) {
      byCategory.set(key, skill.category);
      categories.push(skill.category);
    }
    all.push({ ...skill, category: byCategory.get(key) });
  }
  const byId = new Map(all.map(skill => [String(skill.id), skill]));
  return { skills: all, categories, byId };
}
