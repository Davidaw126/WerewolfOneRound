import copy
import csv
import random
import json

from flask import render_template, request, jsonify, session, redirect, url_for

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
    if 'currentUser' in session:
        return render_template(page_name + ".html")
    else:
        return redirect(url_for('main_page'))

@app.route('/database/reset')
def reset_database():
    User.drop_collection()
    Room.drop_collection()
    resp = jsonify(exists=False)
    return resp

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
    form_data = request.form
    insertData = User(name=form_data['username'],admin=False)
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
        if ins:
            resp = jsonify(exists=True)
            resp.status_code = 200
            return resp

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp

def check_room():
    room = request.form['room']
    if room and request.method == 'POST':

        ins = Room.objects(roomNumber= room)
        print(ins)
        if ins:
            resp = jsonify(exists=True)
            resp.status_code = 200
            return resp

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp

@app.route('/room/add', methods=['POST'])
def add_room():
    roomNumber = "%06d" % random.randint(0,100000) if request.form['createEnter'] ==  'createRoom' else request.form['room']

    if roomNumber and request.method == 'POST':

        username = session['currentUser']
        session['roomNumber'] = roomNumber

        # Update room number in user data
        user = User.objects(name=username)
        user.update(room=roomNumber,admin=False)

        # If room number not exists, create a new room
        roomExists=Room.objects(roomNumber=roomNumber)

        if not roomExists:
            roomInsert = Room(roomNumber=roomNumber,lockStatus=False)
            roomInsert.save()


    resp = jsonify("Room is attached to the user")
    resp.status_code = 200
    return resp


@app.route('/room/settings', methods=['POST'])
def settings_room():
    roomSettings = request.form.to_dict()
    print(roomSettings)

    username = session['currentUser']
    user = User.objects(name=username)
    roomNumber = user.first().room
    user.update(admin=True)

    room = Room.objects(roomNumber=roomNumber)

    room.update(roomSettings=roomSettings,
                lockStatus=False,
                seats=None,
                stageOrder=None,
                identities=None,
                numberOfSeats=sum(list(map(int, roomSettings.values()))))

    #call game_shuffle to shuffle the cards
    game_shuffle()

    resp = jsonify(exists=False)
    resp.status_code = 200
    return resp

@app.route('/room/lock', methods=['POST'])
def room_lock():
    lockStatus = request.form['lockStatus']
    roomNumber = session['roomNumber']
    room = Room.objects(roomNumber=roomNumber)

    room.update(lockStatus=bool(int(lockStatus)))

    resp = jsonify(exists=lockStatus)
    resp.status_code = 200
    return resp

@app.route('/game/cardStatus', methods=['POST'])
def game_cardStatus():
    roomNumber = session['roomNumber']
    room = Room.objects(roomNumber=roomNumber)

    username = session['currentUser']
    user = User.objects(name=username)

    seatNumber = user.first().seat
    cardStatus = copy.copy(room.first().cardStatus)
    roomSettings = copy.copy(room.first().roomSettings)
    numberOfSeats = copy.copy(room.first().numberOfSeats)

    cardStatus.append(seatNumber)
    room.update(cardStatus=cardStatus)

    if "??????" in roomSettings.values():
        numberOfSeats -= 2

    if len(cardStatus) == numberOfSeats:
        game_update()

    resp = jsonify(exists=True)
    resp.status_code = 200
    return resp

@app.route('/game/couple', methods=['POST'])
def game_couple():
    roomNumber = session['roomNumber']
    room = Room.objects(roomNumber=roomNumber)

    username = session['currentUser']
    user = User.objects(name=username)

    seatNumber = user.first().seat
    coupleList = copy.copy(room.first().gameResult['?????????'])
    stageOrder = room.first().stageOrder

    resp = jsonify("??????????????????????????????")
    if stageOrder != None and stageOrder[0] == "??????":
        if coupleList != None:
            splitArray = coupleList.split(",")
            if str(seatNumber) in splitArray:
                resp = jsonify("??????????????????["+splitArray[0]+"???,"+splitArray[1]+"???]")
            else:
                resp = jsonify("??????????????????, ??????????????????")
            game_cardStatus()


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

    if request.method == 'POST':
        username = session['currentUser']
        user = User.objects(name=username)
        oldSeatNumber = user.first().seat
        user.update(seat=newSeatNumber)

        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)

        seatsDict = copy.copy(room.first().seats) if room.first().seats else {}
        if oldSeatNumber:
            seatsDict[str(oldSeatNumber)] = "Empty"

        seatsDict[newSeatNumber] = username[0:12]
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
        thiefGate = False

        roomSettings = room.first().roomSettings
        for k, v in roomSettings.items():
            if k == "??????":
                thiefGate = True
            for x in range(int(v)):
                roleList.append(k)

        random.shuffle(roleList)
        length = len(roleList)
        badList = ["????????????","?????????", "?????????", "??????", "??????", "?????????", "????????????", "??????", "?????????"]
        if thiefGate:
            while roleList[length-1] in badList and roleList[length-1] in badList:
                random.shuffle(roleList)

        for x in range(len(roleList)):
            cardDict[str(x+1)] = roleList[x]

        print(roleList)

        room.update(identities=cardDict,gameResult=None,stageOrder=None)

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

@app.route('/game/checkMatch', methods=['POST'])
def game_checkMatch():
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        stage = room.first().stageOrder

        username = session['currentUser']
        user = User.objects(name=username)
        seatNumber = user.first().seat
        identities = room.first().identities
        roleInRoom = identities[str(seatNumber)]
        condition = stage[0] if stage and stage[0] == roleInRoom else "NOT READY"

    resp = jsonify(condition)
    resp.status_code = 200
    return resp

@app.route('/game/checkCurrentStage', methods=['POST'])
def game_checkCurrentStage():
    stage = ""
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        stage = room.first().stageOrder

    resp = jsonify(stage[0]) if stage else jsonify(False)
    resp.status_code = 200
    return resp


@app.route('/game/update', methods=['POST'])
def game_update():

    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        stageOrder = copy.copy(room.first().stageOrder)
        if len(stageOrder) > 0:
            stageOrder.pop(0)
        room.update(stageOrder=stageOrder)



    resp = jsonify(True)
    resp.status_code = 200
    return resp

@app.route('/game/select', methods=['POST'])
def game_select():
    select = request.form['select']
    powerType = request.form['powerType']

    resp = jsonify(True)
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)

        currentStage = room.first().stageOrder[0]
        identities = copy.copy(room.first().identities)

        username = session['currentUser']
        user = User.objects(name=username)
        seatNumber = user.first().seat

        if powerType == "?????????":
            checkIdRole = room.first().identities[select]
            resp = jsonify(checkIdRole)
        elif powerType == "?????????":
            resp = jsonify(select)
        elif powerType == "??????":
            identities[str(seatNumber)] = str(identities[select])
            room.update(identities=identities)
            resp = jsonify(powerType)


        gameResult = copy.copy(room.first().gameResult) if room.first().gameResult else {}


        if select == "MEDICAL":
            gameResult["??????"] = room.first().gameResult['????????????']
        else:
            gameResult[currentStage] = select

        gameResult['??????'] = "False" if '??????' in gameResult and gameResult['??????'] != "None" and identities[str(gameResult['??????'])] == '??????' else "True"


        room.update(gameResult=gameResult)


    resp.status_code = 200
    return resp

@app.route('/game/order', methods=['POST'])
def stage_order():
    order = json.loads(request.form['stageOrder'])

    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)

        room.update(stageOrder=order)

    resp = jsonify(room.first().stageOrder)
    resp.status_code = 200
    return resp

@app.route('/game/checkGameResult', methods=['POST'])
def game_checkGameResult():
    resp = jsonify(False)
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        gameResult = room.first().gameResult
        resp = jsonify(gameResult)

    resp.status_code = 200
    return resp

@app.route('/game/checkIdentities', methods=['POST'])
def game_checkIdentities():
    resp = jsonify(False)
    if request.method == 'POST':
        roomNumber = session['roomNumber']
        room = Room.objects(roomNumber=roomNumber)
        identities = room.first().identities
        resp = jsonify(identities)

    resp.status_code = 200
    return resp



@app.route('/user/checkAdmin', methods=['POST'])
def user_checkAdmin():
    resp = jsonify(False)

    if request.method == 'POST':
        username = session['currentUser']
        user = User.objects(name=username)
        admin = user.first().admin
        resp = jsonify(admin)

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
