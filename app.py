"""
Budget Planner — Flask application.

Run with:
    python app.py

Then open http://127.0.0.1:5000 in your browser.
"""
from datetime import datetime, date
from flask import Flask, render_template, redirect, url_for, request, jsonify, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user, login_required, current_user
)
from werkzeug.security import generate_password_hash, check_password_hash
import os

# ---------------------------------------------------------------------------
# App configuration
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'change-me-in-production-please')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///budget.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'


# ---------------------------------------------------------------------------
# Database models
# ---------------------------------------------------------------------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    currency_symbol = db.Column(db.String(5), default='€')
    savings = db.Column(db.Float, default=0.0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    categories = db.relationship('Category', backref='user', lazy=True, cascade='all, delete-orphan')
    transactions = db.relationship('Transaction', backref='user', lazy=True, cascade='all, delete-orphan')
    gifts = db.relationship('Gift', backref='user', lazy=True, cascade='all, delete-orphan')
    gift_expenses = db.relationship('GiftExpense', backref='user', lazy=True, cascade='all, delete-orphan')

    def set_password(self, password):
        # Use pbkdf2:sha256 explicitly — Werkzeug's default (scrypt) requires
        # an OpenSSL build that's not always present on macOS Python 3.9.
        self.password_hash = generate_password_hash(password, method='pbkdf2:sha256')

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class Category(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(80), nullable=False)
    budget = db.Column(db.Float, default=0.0)

    transactions = db.relationship('Transaction', backref='category', lazy=True, cascade='all, delete-orphan')


class Transaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    category_id = db.Column(db.Integer, db.ForeignKey('category.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    description = db.Column(db.String(200))
    date = db.Column(db.Date, default=date.today)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Gift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    description = db.Column(db.String(200))
    date = db.Column(db.Date, default=date.today)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class GiftExpense(db.Model):
    """Money spent FROM gifted funds (reduces gifted balance)."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    description = db.Column(db.String(200))
    date = db.Column(db.Date, default=date.today)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user, remember=True)
            return redirect(url_for('dashboard'))
        flash('Invalid username or password.', 'error')

    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        if not username or not password:
            flash('Username and password are required.', 'error')
            return render_template('register.html')
        if len(password) < 6:
            flash('Password must be at least 6 characters.', 'error')
            return render_template('register.html')
        if User.query.filter_by(username=username).first():
            flash('Username already taken.', 'error')
            return render_template('register.html')

        user = User(username=username)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        # Seed a few default categories so the dashboard isn't empty
        defaults = [
            ('Food', 100), ('Clubbing', 100), ('Beauty', 100),
            ('Travel', 100), ('Gym', 50), ('Random', 100),
        ]
        for name, budget in defaults:
            db.session.add(Category(user_id=user.id, name=name, budget=budget))
        db.session.commit()

        login_user(user)
        return redirect(url_for('dashboard'))

    return render_template('register.html')


@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
@app.route('/dashboard')
@login_required
def dashboard():
    return render_template('dashboard.html', user=current_user)


# ---------------------------------------------------------------------------
# JSON API — used by the dashboard JS
# ---------------------------------------------------------------------------
@app.route('/api/summary')
@login_required
def api_summary():
    """Return everything the dashboard needs in one payload."""
    cats = []
    total_budget = 0.0
    total_actual = 0.0
    for c in current_user.categories:
        actual = sum(t.amount for t in c.transactions)
        total_budget += c.budget
        total_actual += actual
        cats.append({
            'id': c.id,
            'name': c.name,
            'budget': round(c.budget, 2),
            'actual': round(actual, 2),
            'difference': round(c.budget - actual, 2),
        })

    gifts = sorted(current_user.gifts, key=lambda g: g.date, reverse=True)
    gifts_received = sum(g.amount for g in gifts)
    gift_expenses = sorted(current_user.gift_expenses, key=lambda e: e.date, reverse=True)
    gifts_spent = sum(e.amount for e in gift_expenses)
    gifted_total = gifts_received - gifts_spent
    living_remaining = total_budget - total_actual

    # Combined ledger of gift activity (deposits + spending), most recent first
    gift_ledger = []
    for g in gifts:
        gift_ledger.append({
            'id': g.id, 'kind': 'gift',
            'amount': round(g.amount, 2),
            'description': g.description or '',
            'date': g.date.isoformat() if g.date else '',
        })
    for e in gift_expenses:
        gift_ledger.append({
            'id': e.id, 'kind': 'expense',
            'amount': round(e.amount, 2),
            'description': e.description or '',
            'date': e.date.isoformat() if e.date else '',
        })
    gift_ledger.sort(key=lambda x: x['date'], reverse=True)

    transactions = []
    for c in current_user.categories:
        for t in c.transactions:
            transactions.append({
                'id': t.id,
                'category_id': c.id,
                'category': c.name,
                'amount': round(t.amount, 2),
                'description': t.description or '',
                'date': t.date.isoformat() if t.date else '',
            })
    transactions.sort(key=lambda x: x['date'], reverse=True)

    return jsonify({
        'currency': current_user.currency_symbol,
        'username': current_user.username,
        'savings': round(current_user.savings, 2),
        'living_budget_total': round(total_budget, 2),
        'living_actual_total': round(total_actual, 2),
        'living_remaining': round(living_remaining, 2),
        'gifts_received': round(gifts_received, 2),
        'gifts_spent': round(gifts_spent, 2),
        'gifted_total': round(gifted_total, 2),
        'total_money': round(living_remaining + gifted_total + current_user.savings, 2),
        'categories': cats,
        'gifts': [
            {'id': g.id, 'amount': round(g.amount, 2), 'description': g.description or '', 'date': g.date.isoformat() if g.date else ''}
            for g in gifts
        ],
        'gift_expenses': [
            {'id': e.id, 'amount': round(e.amount, 2), 'description': e.description or '', 'date': e.date.isoformat() if e.date else ''}
            for e in gift_expenses
        ],
        'gift_ledger': gift_ledger,
        'transactions': transactions[:20],  # most recent 20
    })


# --- Currency ----------------------------------------------------------------
@app.route('/api/currency', methods=['POST'])
@login_required
def api_currency():
    data = request.get_json(silent=True) or {}
    symbol = (data.get('symbol') or '').strip()[:5]
    if symbol:
        current_user.currency_symbol = symbol
        db.session.commit()
    return jsonify({'ok': True, 'currency': current_user.currency_symbol})


# --- Savings -----------------------------------------------------------------
@app.route('/api/savings', methods=['POST'])
@login_required
def api_savings():
    data = request.get_json(silent=True) or {}
    try:
        current_user.savings = float(data.get('amount', 0))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'error': 'Invalid amount'}), 400
    db.session.commit()
    return jsonify({'ok': True, 'savings': current_user.savings})


# --- Categories --------------------------------------------------------------
@app.route('/api/categories', methods=['POST'])
@login_required
def api_add_category():
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    try:
        budget = float(data.get('budget', 0))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'error': 'Invalid budget'}), 400
    if not name:
        return jsonify({'ok': False, 'error': 'Name required'}), 400
    cat = Category(user_id=current_user.id, name=name, budget=budget)
    db.session.add(cat)
    db.session.commit()
    return jsonify({'ok': True, 'id': cat.id})


@app.route('/api/categories/<int:cid>', methods=['PUT', 'DELETE'])
@login_required
def api_edit_category(cid):
    cat = Category.query.filter_by(id=cid, user_id=current_user.id).first_or_404()
    if request.method == 'DELETE':
        db.session.delete(cat)
        db.session.commit()
        return jsonify({'ok': True})

    data = request.get_json(silent=True) or {}
    if 'name' in data:
        cat.name = (data['name'] or '').strip() or cat.name
    if 'budget' in data:
        try:
            cat.budget = float(data['budget'])
        except (TypeError, ValueError):
            return jsonify({'ok': False, 'error': 'Invalid budget'}), 400
    db.session.commit()
    return jsonify({'ok': True})


# --- Transactions ------------------------------------------------------------
@app.route('/api/transactions', methods=['POST'])
@login_required
def api_add_transaction():
    data = request.get_json(silent=True) or {}
    try:
        cid = int(data.get('category_id'))
        amount = float(data.get('amount'))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'error': 'Invalid input'}), 400
    cat = Category.query.filter_by(id=cid, user_id=current_user.id).first()
    if not cat:
        return jsonify({'ok': False, 'error': 'Unknown category'}), 400
    description = (data.get('description') or '').strip()
    txn_date = date.today()
    if data.get('date'):
        try:
            txn_date = datetime.strptime(data['date'], '%Y-%m-%d').date()
        except ValueError:
            pass
    txn = Transaction(
        user_id=current_user.id,
        category_id=cid,
        amount=amount,
        description=description,
        date=txn_date,
    )
    db.session.add(txn)
    db.session.commit()
    return jsonify({'ok': True, 'id': txn.id})


@app.route('/api/transactions/<int:tid>', methods=['DELETE'])
@login_required
def api_delete_transaction(tid):
    txn = Transaction.query.filter_by(id=tid, user_id=current_user.id).first_or_404()
    db.session.delete(txn)
    db.session.commit()
    return jsonify({'ok': True})


# --- Gifts -------------------------------------------------------------------
@app.route('/api/gifts', methods=['POST'])
@login_required
def api_add_gift():
    data = request.get_json(silent=True) or {}
    try:
        amount = float(data.get('amount'))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'error': 'Invalid amount'}), 400
    description = (data.get('description') or '').strip()
    gift_date = date.today()
    if data.get('date'):
        try:
            gift_date = datetime.strptime(data['date'], '%Y-%m-%d').date()
        except ValueError:
            pass
    gift = Gift(user_id=current_user.id, amount=amount, description=description, date=gift_date)
    db.session.add(gift)
    db.session.commit()
    return jsonify({'ok': True, 'id': gift.id})


@app.route('/api/gifts/<int:gid>', methods=['DELETE'])
@login_required
def api_delete_gift(gid):
    gift = Gift.query.filter_by(id=gid, user_id=current_user.id).first_or_404()
    db.session.delete(gift)
    db.session.commit()
    return jsonify({'ok': True})


# --- Gift expenses (spending FROM gifted money) -----------------------------
@app.route('/api/gift-expenses', methods=['POST'])
@login_required
def api_add_gift_expense():
    data = request.get_json(silent=True) or {}
    try:
        amount = float(data.get('amount'))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'error': 'Invalid amount'}), 400
    if amount <= 0:
        return jsonify({'ok': False, 'error': 'Amount must be positive'}), 400
    description = (data.get('description') or '').strip()
    exp_date = date.today()
    if data.get('date'):
        try:
            exp_date = datetime.strptime(data['date'], '%Y-%m-%d').date()
        except ValueError:
            pass
    exp = GiftExpense(
        user_id=current_user.id,
        amount=amount,
        description=description,
        date=exp_date,
    )
    db.session.add(exp)
    db.session.commit()
    return jsonify({'ok': True, 'id': exp.id})


@app.route('/api/gift-expenses/<int:eid>', methods=['DELETE'])
@login_required
def api_delete_gift_expense(eid):
    exp = GiftExpense.query.filter_by(id=eid, user_id=current_user.id).first_or_404()
    db.session.delete(exp)
    db.session.commit()
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
def init_db():
    with app.app_context():
        db.create_all()


if __name__ == '__main__':
    init_db()
    app.run(debug=True, host='127.0.0.1', port=5000)