const express = require('express');
const router = express.Router();
const database = require('../config/database').getDB();
const { authenticate, checkRecipeOwnership } = require('../middleware/auth');

// ============================================
// 1. REQUÊTES SQL
// ============================================

const sql = {
    // --- LECTURE (GET) ---
    getAll: `
        SELECT 
            r.recipe_id, r.title, r.description, r.image_url, 
            c.name as cuisine_name, 
            g.name as goal_name,
            d.name as diet_name,
            a.name as allergy_name
        FROM Recipes r
        LEFT JOIN Cuisines c ON r.cuisine_id = c.cuisine_id
        LEFT JOIN Goals g ON r.goal_id = g.goal_id
        LEFT JOIN DietaryInformation d ON r.DietaryInformation_id = d.diet_id
        LEFT JOIN AllergiesInformation a ON r.AllergiesInformation_id = a.allergy_id
    `,

    getById: `
        SELECT 
            r.*, 
            c.name as cuisine_name, 
            g.name as goal_name,
            d.name as diet_name,
            a.name as allergy_name
        FROM Recipes r
        LEFT JOIN Cuisines c ON r.cuisine_id = c.cuisine_id
        LEFT JOIN Goals g ON r.goal_id = g.goal_id
        LEFT JOIN DietaryInformation d ON r.DietaryInformation_id = d.diet_id
        LEFT JOIN AllergiesInformation a ON r.AllergiesInformation_id = a.allergy_id
        WHERE r.recipe_id = ?
    `,

    getIngredients: `
        SELECT i.ingredient_id, i.name, i.unit, ri.quantity 
        FROM RecipeIngredients ri
        JOIN Ingredients i ON ri.ingredient_id = i.ingredient_id
        WHERE ri.recipe_id = ?
    `,

    getInstructions: `
        SELECT instruction_id, step_number, description 
        FROM RecipeInstructions 
        WHERE recipe_id = ? 
        ORDER BY step_number ASC
    `,

    getByCuisine: `SELECT r.*, c.name as cuisine_name FROM Recipes r JOIN Cuisines c ON r.cuisine_id = c.cuisine_id WHERE r.cuisine_id = ?`,
    getByGoal: `SELECT r.*, g.name as goal_name FROM Recipes r JOIN Goals g ON r.goal_id = g.goal_id WHERE r.goal_id = ?`,
    getWithoutAllergen: `SELECT r.* FROM Recipes r WHERE r.AllergiesInformation_id != ? OR r.AllergiesInformation_id IS NULL`,
    getByUserId: `SELECT r.*, c.name as cuisine_name FROM Recipes r LEFT JOIN Cuisines c ON r.cuisine_id = c.cuisine_id WHERE r.user_id = ? ORDER BY r.recipe_id DESC`,

    // --- ÉCRITURE (POST/INSERT) ---
    create: `
        INSERT INTO Recipes (title, description, image_url, cuisine_id, goal_id, DietaryInformation_id, AllergiesInformation_id, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,

    findIngredientByName: 'SELECT ingredient_id FROM Ingredients WHERE name = ?',
    createIngredient: 'INSERT INTO Ingredients (name, unit) VALUES (?, ?)',
    linkIngredientToRecipe: 'INSERT INTO RecipeIngredients (recipe_id, ingredient_id, quantity) VALUES (?, ?, ?)',
    addInstructionStep: 'INSERT INTO RecipeInstructions (recipe_id, step_number, description, ingredient_id) VALUES (?, ?, ?, ?)',

    // --- MODIFICATION ---
    addIngredient: 'INSERT INTO RecipeIngredients (recipe_id, ingredient_id, quantity) VALUES (?, ?, ?)',
    updateTitle: 'UPDATE Recipes SET title = ? WHERE recipe_id = ?',
    updateAllergy: 'UPDATE Recipes SET AllergiesInformation_id = ? WHERE recipe_id = ?',
    updateInstruction: 'UPDATE RecipeInstructions SET description = ? WHERE instruction_id = ? AND recipe_id = ?',
    
    // --- SUPPRESSION & NETTOYAGE ---
    deleteRecipeIngredients: 'DELETE FROM RecipeIngredients WHERE recipe_id = ?',
    deleteRecipeInstructions: 'DELETE FROM RecipeInstructions WHERE recipe_id = ?',
    deleteRecipeRatings: 'DELETE FROM RecipeRatings WHERE recipe_id = ?',
    deleteRecipe: 'DELETE FROM Recipes WHERE recipe_id = ?',
    
    // ✨ MAGIE : Supprime les ingrédients qui ne sont liés à AUCUNE recette
    deleteUnusedIngredients: 'DELETE FROM Ingredients WHERE ingredient_id NOT IN (SELECT ingredient_id FROM RecipeIngredients)',
    
    removeIngredient: 'DELETE FROM RecipeIngredients WHERE recipe_id = ? AND ingredient_id = ?',
    checkOwnership: 'SELECT user_id FROM Recipes WHERE recipe_id = ?'
};

// ============================================
// 2. FONCTIONS UTILITAIRES (Async Wrapper)
// ============================================

const runQuery = (query, params) => {
    return new Promise((resolve, reject) => {
        database.run(query, params, function(err) {
            if (err) reject(err);
            else resolve(this); // 'this' contient lastID et changes
        });
    });
};

const getQuery = (query, params) => {
    return new Promise((resolve, reject) => {
        database.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

// ============================================
// 3. ROUTES RECETTES
// ============================================

// CRÉATION
router.post('/', authenticate, async (req, res) => {
    let { title, description, image_url, cuisine_id, goal_id, DietaryInformation_id, AllergiesInformation_id, ingredients, instructions } = req.body;
    const userId = req.user.user_id;

    if (!title || !description || !cuisine_id || !goal_id) {
        return res.status(400).json({ success: false, message: 'Title, description, cuisine_id, and goal_id are required' });
    }

    try {
        const result = await runQuery(sql.create, [
            title, description, image_url, cuisine_id, goal_id, DietaryInformation_id, AllergiesInformation_id, userId
        ]);
        const newRecipeId = result.lastID;

        // Ingrédients
        if (ingredients && Array.isArray(ingredients)) {
            for (const ing of ingredients) {
                if (!ing.name) continue;
                let ingId;
                const existingIng = await getQuery(sql.findIngredientByName, [ing.name]);

                if (existingIng) {
                    ingId = existingIng.ingredient_id;
                } else {
                    const createResult = await runQuery(sql.createIngredient, [ing.name, ing.unit || '']);
                    ingId = createResult.lastID;
                }
                await runQuery(sql.linkIngredientToRecipe, [newRecipeId, ingId, Number(ing.quantity) || 0]);
            }
        }

        // Instructions (Gestion String ou Array)
        if (typeof instructions === 'string') {
            instructions = instructions.split('\n').filter(line => line.trim() !== '');
        }

        if (instructions && Array.isArray(instructions)) {
            for (let i = 0; i < instructions.length; i++) {
                const inst = instructions[i];
                const stepNum = inst.step_number || (i + 1);
                const desc = inst.description || inst; 

                if (desc && typeof desc === 'string' && desc.trim().length > 0) {
                    // On met NULL pour ingredient_id car le frontend ne l'envoie pas encore
                    await runQuery(sql.addInstructionStep, [newRecipeId, stepNum, desc.trim(), null]);
                }
            }
        }

        res.status(201).json({
            success: true,
            message: 'Recipe created successfully',
            data: { recipe_id: newRecipeId, title, user_id: userId }
        });

    } catch (err) {
        console.error("❌ Erreur création:", err);
        res.status(500).json({ success: false, message: 'Failed to create recipe', error: err.message });
    }
});

// GET ALL
router.get('/', (req, res) => {
    database.all(sql.getAll, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(200).json({ success: true, count: rows.length, data: rows });
    });
});

// GET MY RECIPES
router.get('/my-recipes', authenticate, (req, res) => {
    database.all(sql.getByUserId, [req.user.user_id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(200).json({ success: true, count: rows.length, data: rows });
    });
});

// GET BY ID
router.get('/:id', (req, res) => {
    const recipeId = req.params.id;
    database.get(sql.getById, [recipeId], (err, recipe) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found' });

        database.all(sql.getIngredients, [recipeId], (err, ingredients) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            
            database.all(sql.getInstructions, [recipeId], (err, instructions) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                
                recipe.ingredients = ingredients;
                recipe.instructions = instructions;
                res.status(200).json({ success: true, data: recipe });
            });
        });
    });
});

// FILTERS
router.get('/cuisine/:cuisineId', (req, res) => {
    database.all(sql.getByCuisine, [req.params.cuisineId], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(200).json({ success: true, count: rows.length, data: rows });
    });
});
router.get('/goal/:goalId', (req, res) => {
    database.all(sql.getByGoal, [req.params.goalId], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(200).json({ success: true, count: rows.length, data: rows });
    });
});
router.get('/no-allergens/:allergyId', (req, res) => {
    database.all(sql.getWithoutAllergen, [req.params.allergyId], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(200).json({ success: true, count: rows.length, data: rows });
    });
});

// UPDATE
router.put('/:id/title', authenticate, checkRecipeOwnership, (req, res) => {
    const { title } = req.body;
    if (!title || title.trim().length === 0) return res.status(400).json({ success: false, message: 'Title required' });
    
    database.run(sql.updateTitle, [title, req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(200).json({ success: true, message: 'Title updated' });
    });
});

router.put('/:id/allergy', authenticate, checkRecipeOwnership, (req, res) => {
    database.run(sql.updateAllergy, [req.body.AllergiesInformation_id, req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(200).json({ success: true, message: 'Allergy info updated' });
    });
});

router.put('/:id/instructions/:stepId', authenticate, checkRecipeOwnership, (req, res) => {
    const { description } = req.body;
    if (!description) return res.status(400).json({ success: false, message: 'Description required' });

    database.run(sql.updateInstruction, [description, req.params.stepId, req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Instruction not found' });
        res.status(200).json({ success: true, message: 'Instruction updated' });
    });
});

// ============================================
// SUPPRESSION AUTOMATISÉE ET NETTOYAGE
// ============================================
router.delete('/:id', authenticate, checkRecipeOwnership, async (req, res) => {
    const id = req.params.id;

    try {
        // 1. Supprimer les liens Ingrédients de CETTE recette
        await runQuery(sql.deleteRecipeIngredients, [id]);
        
        // 2. Supprimer les Instructions de CETTE recette
        await runQuery(sql.deleteRecipeInstructions, [id]);
        
        // 3. Supprimer les Notes/Avis de CETTE recette
        await runQuery(sql.deleteRecipeRatings, [id]);
        
        // 4. Supprimer la Recette elle-même
        await runQuery(sql.deleteRecipe, [id]);

        // 5. NETTOYAGE GLOBAL : Supprimer les ingrédients qui ne servent plus à personne
        // On ne passe pas d'ID ici, c'est un scan global
        await runQuery(sql.deleteUnusedIngredients, []);

        res.status(200).json({ success: true, message: 'Recette supprimée et base de données nettoyée.' });

    } catch (err) {
        console.error("Erreur suppression:", err);
        res.status(500).json({ success: false, message: 'Erreur lors de la suppression', error: err.message });
    }
});

// INGREDIENTS ROUTES (Ajout/Suppression unitaire)
router.post('/:id/ingredients', authenticate, (req, res) => {
    const { ingredient_id, quantity } = req.body;
    if (!ingredient_id || !quantity) return res.status(400).json({ success: false, message: 'Missing data' });

    database.run(sql.addIngredient, [req.params.id, ingredient_id, quantity], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(201).json({ success: true, message: 'Ingredient added' });
    });
});

router.delete('/:recipeId/ingredients/:ingredientId', authenticate, checkRecipeOwnership, (req, res) => {
    database.run(sql.removeIngredient, [req.params.recipeId, req.params.ingredientId], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Ingredient not found in recipe' });
        res.status(200).json({ success: true, message: 'Ingredient removed' });
    });
});

// RATINGS
router.post('/:id/ratings', authenticate, (req, res) => {
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating 1-5 required' });

    const q = `INSERT OR REPLACE INTO RecipeRatings (recipe_id, user_id, rating, review_text, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`;
    database.run(q, [req.params.id, req.user.user_id, rating, review || null], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.status(201).json({ success: true, message: 'Rating added' });
    });
});

router.get('/:id/ratings', (req, res) => {
    const q = `SELECT rr.rating, rr.review_text, rr.created_at, u.username FROM RecipeRatings rr JOIN Users u ON rr.user_id = u.user_id WHERE rr.recipe_id = ? ORDER BY rr.created_at DESC`;
    database.all(q, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const avg = rows.length > 0 ? rows.reduce((s, r) => s + r.rating, 0) / rows.length : 0;
        res.status(200).json({ success: true, data: { average_rating: avg.toFixed(1), total_ratings: rows.length, ratings: rows } });
    });
});

module.exports = router;