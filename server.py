import copy
import csv
import random

from flask import render_template, request, jsonify, session

from globals import User, app, Room

jd = [{"name": "Aw", "roles": "admin"}, {"name": "Tai", "roles": "user"}]

for e in jd:
    print(e.get("name"))



@app.route('/')
#@cross_origin(origin='*', headers=['Content- Type', 'Authorization'])
def main_page():
    return render_template('about.html')


@app.route('/<page_name>', methods=['GET'])
def page(page_name):
    print(session)
    # if 'currentUser' in session:
    return render_template(page_name + ".html")
    # else:
    # return render_template("about.html")


@app.route('/username/check', methods=['POST'])
def add_user():
    _json = request.json
    username = request.form['username']
    if username and request.method == 'POST':
        ins = User.objects(name=username)
        if len(ins) > 0:
            resp = jsonify(exists=True)
            resp.status_code = 200
            return resp

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp


@app.route('/username/submit', methods=['POST'])
def submit():
    form_data = request.form.to_dict()
    insertData = User(name=form_data['username'])
    insertData.save()
    session['currentUser'] = form_data['username']
    print(session)
    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp


@app.route('/room/check', methods=['POST'])
def check_room():
    room = request.form['room']
    if room and request.method == 'POST':

        ins = Room.objects(roomNumber= room)
        print(ins)
        if ins and ins.first().readyStatus:
            resp = jsonify(exists=True)
            resp.status_code = 200
            return resp

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp


@app.route('/room/add', methods=['POST'])
def add_room():
    roomNumber = "%06d" % random.randint(0,999999) if request.form['createEnter'] ==  'createRoom' else request.form['room']

    if roomNumber and request.method == 'POST':

        username = session['currentUser']
        session['roomNumber'] = roomNumber

        # Update room number in user data
        user = User.objects(name=username)
        user.update(room=roomNumber)

        # If room number not exists, create a new room
        roomExists=Room.objects(roomNumber=roomNumber)

        if not roomExists:
            roomInsert = Room(roomNumber=roomNumber,readyStatus=False)
            roomInsert.save()


    resp = jsonify("Room is attached to the user")
    resp.status_code = 200
    return resp


@app.route('/room/settings', methods=['POST'])
def settings_room():
    roomSettings = request.form.to_dict()

    username = session['currentUser']
    user = User.objects(name=username)
    roomNumber = user.first().room

    room = Room.objects(roomNumber=roomNumber)
    room.update(roomSettings=roomSettings,readyStatus=True,numberOfSeats=sum(list(map(int, roomSettings.values()))))

    #call game_shuffle to shuffle the cards
    game_shuffle()

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp


@app.route('/logout', methods=['GET'])
def log_out():
    session.pop('currentUser', default=None)
    resp = jsonify(exists=True)
    resp.status_code = 200
    return resp

@app.route('/seat/refresh', methods=['POST'])
def seat_refresh():
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        roomWhole = room.first()

    resp = jsonify(roomWhole)
    resp.status_code = 200
    return resp

@app.route('/seat/take', methods=['POST'])
def seat_take():
    newSeatNumber = request.form['seatNumber']

    roomNumber = session['roomNumber']
    room = Room.objects(roomNumber=roomNumber)
    identities = room.first().identities
    role = identities[newSeatNumber]

    if request.method == 'POST':
        username = session['currentUser']
        user = User.objects(name=username)
        oldSeatNumber = user.first().seat
        user.update(seat=newSeatNumber,role=role)

        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)

        seatsDict = copy.copy(room.first().seats) if room.first().seats else {}
        if oldSeatNumber:
            seatsDict[str(oldSeatNumber)] = "Empty"

        seatsDict[newSeatNumber] = username
        room.update(seats = seatsDict)

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp

@app.route('/game/shuffle', methods=['POST'])
def game_shuffle():
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)

        cardDict = {}
        roleList = []
        roomSettings = room.first().roomSettings
        for k, v in roomSettings.items():
            for x in range(int(v)):
                roleList.append(k)

        random.shuffle(roleList)
        for x in range(len(roleList)):
            cardDict[str(x+1)] = roleList[x]

        print(cardDict)

        room.update(identities=cardDict)

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp

@app.route('/game/checkRole', methods=['POST'])
def game_checkRole():
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)

        username = session['currentUser']
        user = User.objects(name=username)

        seatNumber = user.first().seat
        identities = room.first().identities

        role = {str(seatNumber): identities[str(seatNumber)]}


    resp = jsonify(role)
    resp.status_code = 200
    return resp

@app.route('/game/check', methods=['POST'])
def game_check():

    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        stage = room.first().currentStage

        username = session['currentUser']
        user = User.objects(name=username)
        role = user.first().role

        condition = stage if stage == role else "Not Ready"

    resp = jsonify(condition)
    resp.status_code = 200
    return resp


@app.route('/game/update', methods=['POST'])
def game_update():
    currentStage = request.form['currentStage']

    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        room.update(currentStage=currentStage)

    resp = jsonify(True)
    resp.status_code = 200
    return resp


def write_to_file(data):
    with open('database.txt', mode='a') as database:
        email = data["email"]
        subject = data["subject"]
        message = data["message"]
        file = database.write(f'\n{email},{subject},{message}')


def write_to_csv(data):
    with open('database.csv', mode='a', newline='') as database2:
        email = data["email"]
        subject = data["subject"]
        message = data["message"]
        csv_writer = csv.writer(database2, delimiter=",", quotechar='"', quoting=csv.QUOTE_MINIMAL)
        csv_writer.writerow([email, subject, message])


if __name__ == "__main__":
    app.run(debug=True)
