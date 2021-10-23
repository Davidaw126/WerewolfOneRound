from flask import Flask
from flask_cors import CORS
from flask_mongoengine import MongoEngine

db = MongoEngine()
app = Flask(__name__)
app.config['MONGODB_SETTINGS'] = {
    'host': 'mongodb://localhost:27017/werewolf'
}

CORS(app)
db.init_app(app)
app.secret_key = 'BAD_SECRET_KE'

class User(db.Document):
    name = db.StringField(required=True)
    _id = db.StringField()
    room = db.IntField()
    role = db.StringField()
    inputBool = db.StringField()
    seat = db.IntField()


class Room(db.Document):
    roomNumber = db.IntField()
    readyStatus = db.BooleanField()
    seats = db.DictField()
    identities = db.DictField()
    roomSettings = db.DictField()
    numberOfSeats =  db.IntField()